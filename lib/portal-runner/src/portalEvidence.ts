/**
 * PII-safe structural evidence captured when a portal run cannot prove a
 * terminal outcome. Values, cookies, storage, request bodies and query strings
 * are deliberately excluded. The result is safe to persist in resultJson and
 * to forward to Portal Automation Guardian after its second redaction pass.
 */

export interface PortalFieldEvidence {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  role?: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  invalid: boolean;
  visible: boolean;
  optionCount?: number;
}

export interface PortalRunEvidence {
  schemaVersion: 1;
  capturedAt: string;
  adapterKey: string;
  url: {
    origin: string;
    pathname: string;
  };
  title?: string;
  headings: string[];
  buttons: string[];
  fields: PortalFieldEvidence[];
  validation: string[];
  progress: Array<{
    tag: string;
    text?: string;
    className?: string;
    current?: string;
  }>;
  shadowHosts: string[];
  counts: {
    shadowRoots: number;
    visibleFields: number;
    invalidFields: number;
    fileInputs: number;
  };
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE =
  /(?<!\d)(?:\+\s*)?\d(?:[\s().-]*\d){7,}(?!\d)/g;
const LONG_ID_RE = /\b[A-Z0-9][A-Z0-9-]{7,}\b/gi;
const URL_QUERY_RE = /(https?:\/\/[^\s?#]+)\?[^\s#]*/gi;
const KEY_VALUE_RE =
  /(\b(?:value|readback|entered|received|actual|token|passport|email|phone|address)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^,;\n]+)/gi;

export function redactPortalEvidenceText(value: unknown, max = 180): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(EMAIL_RE, "[REDACTED]")
    .replace(PHONE_RE, "[REDACTED]")
    .replace(URL_QUERY_RE, "$1?[REDACTED]")
    .replace(KEY_VALUE_RE, "$1[REDACTED]")
    .replace(LONG_ID_RE, (candidate) =>
      /(?:application|student|stage|step|button|combobox|lightning|accordion|document|personal|information|education|questionnaire|completed|selected|program|passport|transcript|validation|required|available|selection)/i.test(
        candidate,
      )
        ? candidate
        : "[REDACTED]",
    )
    .trim()
    .slice(0, max);
}

function sanitizeField(
  field: PortalFieldEvidence,
): PortalFieldEvidence {
  return {
    tag: redactPortalEvidenceText(field.tag, 40).toLowerCase(),
    ...(field.type
      ? { type: redactPortalEvidenceText(field.type, 60) }
      : {}),
    ...(field.id ? { id: redactPortalEvidenceText(field.id, 120) } : {}),
    ...(field.name
      ? { name: redactPortalEvidenceText(field.name, 120) }
      : {}),
    ...(field.role
      ? { role: redactPortalEvidenceText(field.role, 80) }
      : {}),
    ...(field.label
      ? { label: redactPortalEvidenceText(field.label, 160) }
      : {}),
    ...(field.placeholder
      ? {
          placeholder: redactPortalEvidenceText(field.placeholder, 160),
        }
      : {}),
    required: Boolean(field.required),
    invalid: Boolean(field.invalid),
    visible: Boolean(field.visible),
    ...(typeof field.optionCount === "number"
      ? { optionCount: Math.max(0, Math.min(10_000, field.optionCount)) }
      : {}),
  };
}

export function sanitizePortalRunEvidence(
  value: PortalRunEvidence,
): PortalRunEvidence {
  return {
    schemaVersion: 1,
    capturedAt: value.capturedAt,
    adapterKey: redactPortalEvidenceText(value.adapterKey, 100),
    url: {
      origin: redactPortalEvidenceText(value.url.origin, 300),
      pathname: redactPortalEvidenceText(value.url.pathname, 500),
    },
    ...(value.title
      ? { title: redactPortalEvidenceText(value.title, 200) }
      : {}),
    headings: value.headings
      .slice(0, 30)
      .map((item) => redactPortalEvidenceText(item, 180))
      .filter(Boolean),
    buttons: value.buttons
      .slice(0, 40)
      .map((item) => redactPortalEvidenceText(item, 160))
      .filter(Boolean),
    fields: value.fields.slice(0, 120).map(sanitizeField),
    validation: value.validation
      .slice(0, 30)
      .map((item) => redactPortalEvidenceText(item, 240))
      .filter(Boolean),
    progress: value.progress.slice(0, 40).map((item) => ({
      tag: redactPortalEvidenceText(item.tag, 40).toLowerCase(),
      ...(item.text
        ? { text: redactPortalEvidenceText(item.text, 160) }
        : {}),
      ...(item.className
        ? { className: redactPortalEvidenceText(item.className, 180) }
        : {}),
      ...(item.current
        ? { current: redactPortalEvidenceText(item.current, 80) }
        : {}),
    })),
    shadowHosts: value.shadowHosts
      .slice(0, 60)
      .map((item) => redactPortalEvidenceText(item, 100).toLowerCase())
      .filter(Boolean),
    counts: {
      shadowRoots: Math.max(0, value.counts.shadowRoots | 0),
      visibleFields: Math.max(0, value.counts.visibleFields | 0),
      invalidFields: Math.max(0, value.counts.invalidFields | 0),
      fileInputs: Math.max(0, value.counts.fileInputs | 0),
    },
  };
}

export async function capturePortalRunEvidence(
  page: {
    evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
  },
  adapterKey: string,
): Promise<PortalRunEvidence | null> {
  try {
    const raw = await page.evaluate(() => {
      const clean = (input: unknown, max = 180) =>
        String(input ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max);
      const isVisible = (element: Element): boolean => {
        try {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        } catch {
          return false;
        }
      };

      const roots: Array<Document | ShadowRoot> = [document];
      const all: Element[] = [];
      const seen = new Set<Element>();
      const shadowHosts: string[] = [];
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        const root = roots[rootIndex];
        for (const element of Array.from(root.querySelectorAll("*"))) {
          if (!seen.has(element)) {
            seen.add(element);
            all.push(element);
          }
          const shadowRoot = (element as HTMLElement).shadowRoot;
          if (shadowRoot) {
            roots.push(shadowRoot);
            shadowHosts.push(element.tagName.toLowerCase());
          }
        }
      }

      const findLabel = (element: Element): string => {
        const id = element.getAttribute("id");
        if (id) {
          const label = all.find(
            (candidate) =>
              candidate.tagName === "LABEL" &&
              candidate.getAttribute("for") === id,
          );
          if (label) return clean(label.textContent, 160);
        }
        const parentLabel = element.closest("label");
        return parentLabel ? clean(parentLabel.textContent, 160) : "";
      };

      const fieldElements = all.filter((element) =>
        element.matches(
          "input,select,textarea,[role=combobox],[contenteditable=true]",
        ),
      );
      const fields = fieldElements.map((element) => {
        const input = element as HTMLInputElement;
        const visible = isVisible(element);
        return {
          tag: element.tagName.toLowerCase(),
          type: clean(element.getAttribute("type"), 60),
          id: clean(element.getAttribute("id"), 120),
          name: clean(element.getAttribute("name"), 120),
          role: clean(element.getAttribute("role"), 80),
          label:
            findLabel(element) ||
            clean(element.getAttribute("aria-label"), 160),
          placeholder: clean(element.getAttribute("placeholder"), 160),
          required:
            input.required === true ||
            element.getAttribute("aria-required") === "true",
          invalid: element.getAttribute("aria-invalid") === "true",
          visible,
          optionCount:
            element.tagName === "SELECT"
              ? (element as HTMLSelectElement).options.length
              : undefined,
        };
      });
      const visibleFields = fields.filter((field) => field.visible);

      const textOf = (selector: string, maxItems: number, maxText: number) =>
        all
          .filter(
            (element) => element.matches(selector) && isVisible(element),
          )
          .map((element) => clean(element.textContent, maxText))
          .filter(Boolean)
          .slice(0, maxItems);

      const url = new URL(location.href);
      return {
        schemaVersion: 1 as const,
        capturedAt: new Date().toISOString(),
        adapterKey: "",
        url: { origin: url.origin, pathname: url.pathname },
        title: clean(document.title, 200),
        headings: textOf("h1,h2,h3,legend", 30, 180),
        buttons: all
          .filter(
            (element) =>
              element.matches(
                "button,[role=button],input[type=button],input[type=submit]",
              ) && isVisible(element),
          )
          .map((element) =>
            clean(
              element.getAttribute("aria-label") ||
                element.textContent ||
                element.getAttribute("value"),
              160,
            ),
          )
          .filter(Boolean)
          .slice(0, 40),
        fields,
        validation: textOf(
          '[role=alert],[aria-live],.slds-form-element__help,.field-validation-error,.invalid-feedback,.k-form-error',
          30,
          240,
        ),
        progress: all
          .filter(
            (element) =>
              element.matches(
                ".slds-path__item,.slds-path__stage-name,.slds-path__title,[role=tab],[aria-current=step],.k-step-link",
              ) && isVisible(element),
          )
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: clean(element.textContent, 160),
            className: clean(element.getAttribute("class"), 180),
            current: clean(element.getAttribute("aria-current"), 80),
          }))
          .slice(0, 40),
        shadowHosts: Array.from(new Set(shadowHosts)).slice(0, 60),
        counts: {
          shadowRoots: roots.length - 1,
          visibleFields: visibleFields.length,
          invalidFields: visibleFields.filter((field) => field.invalid).length,
          fileInputs: visibleFields.filter((field) => field.type === "file")
            .length,
        },
      };
    });
    return sanitizePortalRunEvidence({ ...raw, adapterKey });
  } catch {
    return null;
  }
}

export class PortalRunError extends Error {
  readonly portalEvidence: PortalRunEvidence | null;

  constructor(message: string, portalEvidence: PortalRunEvidence | null) {
    super(message);
    this.name = "PortalRunError";
    this.portalEvidence = portalEvidence;
  }
}

export function portalEvidenceFromError(
  error: unknown,
): PortalRunEvidence | null {
  return error instanceof PortalRunError ? error.portalEvidence : null;
}
