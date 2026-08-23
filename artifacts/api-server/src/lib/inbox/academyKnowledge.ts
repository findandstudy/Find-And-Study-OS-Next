import crypto from "node:crypto";
import { JSDOM } from "jsdom";

export const ACADEMY_KNOWLEDGE_SOURCE_TYPE = "academy";
export const ACADEMY_KNOWLEDGE_SOURCE_NAME = "Academy Destinations";
export const ACADEMY_PUBLIC_BASE_URL = "https://academy.findandstudy.com";
export const ACADEMY_CHUNK_FORMAT_VERSION = "country-v2";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ARTICLE_CHARS = 20_000;

const INTERNAL_ONLY_BLOCK =
  /\binternal\s+use\s+only\b|\bconfidential\b|\bportal\s+credentials?\b|\bpassword\b|\b(?:agency|partner)\s+(?:pays?|receives?|earns?|completes?)\b|\b(?:consultancy|service)\s+fee\b|\bagency\s+agreement\b|\bdiscounted\s+partner\s+rates?\b|\bpayment\s+structure\s*\(\s*agent\b/i;
const COMMERCIAL_COMMISSION_BLOCK =
  /\bcommission\b/i;
const PUBLIC_AUTHORITY_COMMISSION =
  /\b(?:Pakistan Medical|European|Higher Education|Medical)\s+Commission\b/i;

interface AcademyCountry {
  id: string;
  name: string;
  code: string;
  status: string;
  description?: string | null;
}

interface AcademyContent {
  id: string;
  title: string;
  slug?: string | null;
  description?: string | null;
  type?: string | null;
  countryId?: string | null;
  content?: string | null;
  status?: string | null;
  updatedAt?: string | null;
}

interface AcademyCountriesPayload {
  success?: boolean;
  countries?: AcademyCountry[];
}

interface AcademyContentsPayload {
  success?: boolean;
  contents?: AcademyContent[];
}

export interface AcademyDestinationExtract {
  text: string;
  documents: AcademyDestinationDocument[];
  sourceVersion: string;
  countryCount: number;
  contentCount: number;
  fetchedAt: string;
}

export interface AcademyDestinationDocument {
  countryName: string;
  countryCode: string;
  title: string;
  text: string;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isInternalOnlyBlock(text: string): boolean {
  if (INTERNAL_ONLY_BLOCK.test(text)) return true;
  if (!COMMERCIAL_COMMISSION_BLOCK.test(text)) return false;

  // Official public authorities such as the Pakistan Medical Commission are
  // useful student-facing recognition information. Every other commission
  // reference is treated as commercial partner data and removed.
  return !PUBLIC_AUTHORITY_COMMISSION.test(text);
}

function htmlToStudentSafeText(html: string): string {
  if (!html.trim()) return "";
  const dom = new JSDOM(`<body>${html}</body>`);
  const document = dom.window.document;
  document.querySelectorAll("script, style, noscript, iframe, form").forEach((node) => node.remove());

  const blocks = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, th, td, blockquote"),
  )
    .map((node) => safeText(node.textContent))
    .filter((text) => text.length > 1 && !isInternalOnlyBlock(text));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const key = block.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(block);
  }

  const extracted = deduped.length > 0
    ? deduped.join("\n")
    : safeText(document.body.textContent);
  return extracted.slice(0, MAX_ARTICLE_CHARS);
}

/**
 * Converts Academy's public payload into a student-facing RAG document.
 *
 * Security boundary:
 * - only active destination countries are accepted;
 * - the non-destination "Find And Study" partner section (country code AA)
 *   is excluded;
 * - only published lesson content is accepted;
 * - media rows, placeholders and internal/commission blocks are excluded.
 */
export function buildAcademyDestinationDocument(
  countriesPayload: AcademyCountriesPayload,
  contentsPayload: AcademyContentsPayload,
): Omit<AcademyDestinationExtract, "sourceVersion" | "fetchedAt"> {
  const countries = Array.isArray(countriesPayload.countries)
    ? countriesPayload.countries
    : [];
  const activeCountries = countries.filter((country) =>
    country &&
    typeof country.id === "string" &&
    country.status === "active" &&
    country.code !== "AA",
  );
  const countryById = new Map(activeCountries.map((country) => [country.id, country]));

  const contents = Array.isArray(contentsPayload.contents)
    ? contentsPayload.contents
    : [];
  const accepted = contents
    .filter((item) =>
      item &&
      item.status === "published" &&
      item.type === "lesson" &&
      typeof item.countryId === "string" &&
      countryById.has(item.countryId) &&
      !/^coming\s+soon$/i.test(safeText(item.title)),
    )
    .map((item) => {
      const country = countryById.get(item.countryId!)!;
      const title = safeText(item.title);
      const rawDescription = safeText(item.description);
      const description = isInternalOnlyBlock(rawDescription) ? "" : rawDescription;
      const body = htmlToStudentSafeText(item.content ?? "");
      if (!title || !body) return null;
      return {
        country,
        item,
        text: [
          `ACADEMY DESTINATION: ${country.name} (${country.code})`,
          `TOPIC: ${title}`,
          description ? `SUMMARY: ${description}` : "",
          `INFORMATION:\n${body}`,
          item.updatedAt ? `ACADEMY UPDATED AT: ${item.updatedAt}` : "",
        ].filter(Boolean).join("\n"),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => {
      const countryOrder = a.country.name.localeCompare(b.country.name, "en");
      if (countryOrder !== 0) return countryOrder;
      return a.item.title.localeCompare(b.item.title, "en");
    });

  const includedCountryIds = new Set(accepted.map((row) => row.country.id));
  const preface = [
    "SOURCE: Find And Study Academy — published destination information.",
    "AUDIENCE: Student-facing factual reference.",
    "SAFETY: Never disclose private commercial terms, internal partner processes or unpublished information.",
    "FRESHNESS: Treat dates, prices, visa rules and admission requirements as subject to confirmation when the source says so.",
  ].join("\n");
  const documents = accepted.map((row) => ({
    countryName: row.country.name,
    countryCode: row.country.code.trim().toUpperCase(),
    title: safeText(row.item.title),
    text: [preface, row.text].join("\n\n"),
  }));

  return {
    text: [preface, ...accepted.map((row) => row.text)].join("\n\n---\n\n"),
    documents,
    countryCount: includedCountryIds.size,
    contentCount: accepted.length,
  };
}

async function fetchJson<T>(url: string): Promise<{ data: T; etag: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== ACADEMY_PUBLIC_BASE_URL) {
    throw new Error("Academy source URL is not allowed.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent": "FindAndStudyOS-AcademySync/1.0",
      },
    });
    if (!response.ok) throw new Error(`Academy fetch failed: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Academy returned a non-JSON response.");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("Academy response is too large.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("Academy response is too large.");
    }
    return {
      data: JSON.parse(buffer.toString("utf8")) as T,
      etag: response.headers.get("etag") ?? "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractAcademyDestinations(): Promise<AcademyDestinationExtract> {
  const [countriesResponse, contentsResponse] = await Promise.all([
    fetchJson<AcademyCountriesPayload>(`${ACADEMY_PUBLIC_BASE_URL}/api/public/countries`),
    fetchJson<AcademyContentsPayload>(`${ACADEMY_PUBLIC_BASE_URL}/api/public/contents?lang=en`),
  ]);

  if (countriesResponse.data.success === false || contentsResponse.data.success === false) {
    throw new Error("Academy reported an unsuccessful public-data response.");
  }

  const document = buildAcademyDestinationDocument(
    countriesResponse.data,
    contentsResponse.data,
  );
  if (!document.text.trim() || document.contentCount === 0) {
    throw new Error("Academy returned no student-safe destination content.");
  }

  const upstreamVersion = countriesResponse.etag && contentsResponse.etag
    ? `${countriesResponse.etag}:${contentsResponse.etag}`
    : crypto.createHash("sha256").update(document.text).digest("hex");
  // Include the chunk format so the first sync after this release rebuilds
  // legacy mixed-country chunks with country metadata even when Academy's
  // upstream ETags have not changed.
  const sourceVersion = `${upstreamVersion}:${ACADEMY_CHUNK_FORMAT_VERSION}`;

  return {
    ...document,
    sourceVersion,
    fetchedAt: new Date().toISOString(),
  };
}
