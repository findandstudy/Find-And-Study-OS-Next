import { useEffect, useMemo, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PhoneInput } from "@/components/ui/phone-input";
import {
  Loader2, CheckCircle2, AlertCircle, FileSignature, Eraser,
  Mail, ShieldCheck, Pencil, Upload, FileText, PenLine, X,
} from "lucide-react";
import { getTranslation, isValidLanguage, isLanguageLoaded, loadLanguage, type Language, RTL_LANGUAGES } from "@/lib/i18n/index";
import { FALLBACK_COUNTRIES } from "@/lib/nationalities";
import { CITIES_BY_COUNTRY } from "@/lib/city-data";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SIG_BASE64 = 1_900_000;

type SigningPageConfig = {
  brandName?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  pageTitle?: string;
  pageSubtitle?: string;
  pdfHeaderText?: string;
  pdfFooterText?: string;
} | null;

type SessionView = {
  sessionId: number;
  mode: "admin_driven" | "self_fill";
  status: "intake_pending" | "review_pending" | "signed" | "revoked";
  signerEmail: string;
  verifiedEmail: string | null;
  signerName: string | null;
  expiresAt: string;
  expired: boolean;
  template: { id: number; name: string; language: string; entityType: string; intakeSchema: any[] | null; signingPageConfig: SigningPageConfig };
  agent: any;
  intakeData: Record<string, string> | null;
};

type Step = "loading" | "expired" | "revoked" | "intake" | "review" | "sign" | "success" | "error";
type Brand = {
  companyName: string;
  hasLogo: boolean;
  customLogoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  pageTitle?: string | null;
  pageSubtitle?: string | null;
};
type Tfn = (key: string, params?: Record<string, string | number>) => string;

// Heuristic: detect intake fields that already capture the signer's full name
// so we don't render two identical "name" inputs (template author may have
// added one explicitly, and we always collect signerName for the signature).
const NAME_FIELD_PATTERNS = [
  /full[\s_-]?name/i,
  /signer[\s_-]?name/i,
  /\bname\b/i,
  /isim|ad\s*soyad|ad\s+soyad/i,
  /الاسم/i,
  /имя/i,
  /nom\s+complet/i,
];
function isNameLikeField(f: { key?: string; label?: string }): boolean {
  const haystack = `${f.key || ""} ${f.label || ""}`;
  return NAME_FIELD_PATTERNS.some(rx => rx.test(haystack));
}

// Detect an email field already declared by the template so we attach the
// verification widget to it instead of rendering a duplicate email input.
const EMAIL_FIELD_PATTERNS = [
  /e-?mail/i,
  /eposta|e-posta/i,
  /البريد/i,
  /почт|эл\.?\s*адрес/i,
  /courriel|correo/i,
];
function isEmailLikeField(f: { key?: string; label?: string; type?: string }): boolean {
  if (f.type === "email") return true;
  const haystack = `${f.key || ""} ${f.label || ""}`;
  return EMAIL_FIELD_PATTERNS.some(rx => rx.test(haystack));
}

// The contract year is auto-filled with the current year and locked so the
// signer cannot change it. Detect it by the year keyword or a number field.
function isYearLikeField(f: { key?: string; label?: string; type?: string }): boolean {
  const haystack = `${f.key || ""} ${f.label || ""}`;
  return /year|yıl|yil|سنة|год|année|año/i.test(haystack) || f.type === "number";
}

const CURRENT_YEAR = String(new Date().getFullYear());

export default function SignFlow({ token }: { token: string }) {
  const [step, setStep] = useState<Step>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [session, setSession] = useState<SessionView | null>(null);
  const [intake, setIntake] = useState<Record<string, string>>({});
  const [signerName, setSignerName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [brand, setBrand] = useState<Brand>({ companyName: "", hasLogo: false });

  // Sign-step footer wiring: the signature action button lives in the sticky
  // footer (outside SignaturePad), so we lift readiness + a submit handle up.
  const sigSubmitRef = useRef<(() => void) | null>(null);
  const [sigReady, setSigReady] = useState(false);

  // Email-verification state. The signer enters their own email and proves
  // ownership via a 6-digit code before they are allowed to sign.
  const [email, setEmail] = useState<string>("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);

  // Country catalog fetched from the active country catalog on demand.
  // Falls back to FALLBACK_COUNTRIES if the fetch fails or returns empty.
  const [countryCatalog, setCountryCatalog] = useState<string[]>([]);

  // Sign flow language is driven by the contract template's language so the
  // signing experience matches the language the issuer picked when sending
  // the link, regardless of the recipient's browser locale.
  const lang: Language = useMemo(() => {
    const raw = session?.template?.language;
    return raw && isValidLanguage(raw) ? raw : "en";
  }, [session?.template?.language]);
  const t: Tfn = (key, params) => getTranslation(lang, `sign.${key}`, params);
  const isRTL = RTL_LANGUAGES.includes(lang);

  // Translations are lazy-loaded per language; the sign flow's language comes
  // from the contract template (may differ from the app's active language),
  // so make sure its dictionary is loaded, then re-render.
  const [, setLangLoadedTick] = useState(0);
  useEffect(() => {
    if (!isLanguageLoaded(lang)) {
      void loadLanguage(lang).then(() => setLangLoadedTick((n) => n + 1));
    }
  }, [lang]);

  // Signed PDF is rendered asynchronously by a background worker. The download
  // endpoint returns 202 while it is still being generated, so we fetch it from
  // JS to surface a friendly "still generating" message instead of dumping the
  // raw 202 JSON into a new browser tab.
  async function handleDownloadPdf() {
    setPdfMsg(null);
    setDownloadingPdf(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/public/sign/${encodeURIComponent(token)}/pdf`,
        { credentials: "include" },
      );
      if (res.status === 202) {
        setPdfMsg(getTranslation(lang, "signedContract.pdfPending"));
        return;
      }
      if (!res.ok) {
        setPdfMsg(getTranslation(lang, "signedContract.pdfDownloadError"));
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const filename = m ? decodeURIComponent(m[1]) : "contract.pdf";
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setPdfMsg(getTranslation(lang, "signedContract.pdfDownloadError"));
    } finally {
      setDownloadingPdf(false);
    }
  }

  useEffect(() => {
    if (!session) return;
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL ? "rtl" : "ltr";
  }, [lang, isRTL, session]);

  useEffect(() => {
    (async () => {
      try {
        const b: any = await customFetch(`/api/settings/branding`);
        setBrand({
          companyName: b?.companyName || b?.publicBrandName || "",
          hasLogo: Boolean(b?.logoUrl),
        });
      } catch { /* branding is best-effort */ }
    })();
  }, []);

  // When we leave the sign step, clear the lifted signature wiring so a later
  // return to the sign step can't briefly act on a stale handle/readiness from
  // the previous SignaturePad mount.
  useEffect(() => {
    if (step !== "sign") {
      sigSubmitRef.current = null;
      setSigReady(false);
    }
  }, [step]);

  useEffect(() => {
    (async () => {
      try {
        const res: any = await customFetch(`/api/public/sign/${encodeURIComponent(token)}`);
        const data: SessionView = res.data;
        setSession(data);
        // Merge per-template signing page config into brand so BrandHeader +
        // title/subtitle can use it without a separate fetch.
        const spc = data.template.signingPageConfig;
        if (spc) {
          setBrand(prev => ({
            ...prev,
            companyName: spc.brandName || prev.companyName,
            customLogoUrl: spc.logoUrl || null,
            primaryColor: spc.primaryColor || null,
            accentColor: spc.accentColor || null,
            pageTitle: spc.pageTitle || null,
            pageSubtitle: spc.pageSubtitle || null,
          }));
        }
        setSignerName(data.signerName || "");
        const schema = Array.isArray(data.template.intakeSchema) ? data.template.intakeSchema : [];
        if (schema.length && data.intakeData) setIntake(data.intakeData);
        // Fetch the active country catalog if the schema uses a country field.
        if (schema.some((f: any) => f.type === "country")) {
          customFetch(`/api/public/countries?limit=300`).then((r: any) => {
            const list = (r.data ?? r ?? []) as { name: string }[];
            const names = list.map((c: any) => c.name).filter(Boolean).sort() as string[];
            if (names.length > 0) setCountryCatalog(names);
          }).catch(() => { /* fall back to FALLBACK_COUNTRIES in renderer */ });
        }
        // Lock the contract year to the current year regardless of any saved value.
        const yearField = schema.find(isYearLikeField);
        if (yearField) setIntake(s => ({ ...s, [yearField.key]: CURRENT_YEAR }));
        const ef = schema.find(isEmailLikeField);
        const prefEmail = data.verifiedEmail || (ef ? data.intakeData?.[ef.key] : "") || data.signerEmail || "";
        setEmail(prefEmail || "");
        if (data.verifiedEmail) setVerified(true);
        if (data.expired) { setStep("expired"); return; }
        if (data.status === "signed") { setStep("success"); return; }
        if (data.status === "revoked") { setStep("revoked"); return; }
        if (data.mode === "self_fill" && data.status === "intake_pending") { setStep("intake"); return; }
        setStep("review");
      } catch (err: any) {
        const status = err?.status || err?.response?.status;
        const code = err?.body?.code || err?.response?.data?.code || err?.data?.code;
        const langGuess: Language = "en";
        if (status === 410 && code === "revoked") { setStep("revoked"); return; }
        if (status === 410) { setStep("expired"); return; }
        if (status === 404) { setErrorMsg(getTranslation(langGuess, "sign.notFound")); setStep("error"); return; }
        setErrorMsg(err?.message || getTranslation(langGuess, "sign.loadError")); setStep("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // The contract preview is loaded directly into a sandboxed <iframe src> from
  // a dedicated HTML endpoint so it carries its own (inline-style-allowing) CSP
  // and renders styled in production. The server always renders fresh from the
  // latest saved intake data, so navigating intake -> review remounts the
  // iframe and re-fetches automatically (no separate JSON round-trip needed).
  const previewUrl = `${BASE_URL}/api/public/sign/${encodeURIComponent(token)}/preview.html`;

  const fields = (session?.template.intakeSchema || []) as { key: string; label: string; type: string; required?: boolean; placeholder?: string; options?: string[]; dependsOn?: string }[];
  const nameLikeFields = fields.filter(isNameLikeField);
  const intakeNameField =
    nameLikeFields.find(f => /contact|person|full|signer|ad\s*soyad|isim/i.test(`${f.key} ${f.label}`)) ||
    nameLikeFields[0];
  const intakeEmailField = fields.find(isEmailLikeField);

  function setEmailValue(v: string) {
    setEmail(v);
    if (verified) { setVerified(false); setCodeSent(false); setCode(""); }
    setCodeError("");
  }

  async function sendCode() {
    const value = email.trim();
    if (!EMAIL_RE.test(value)) { setCodeError(t("emailRequired")); return; }
    setSendingCode(true); setCodeError("");
    try {
      await customFetch(`/api/public/sign/${encodeURIComponent(token)}/send-code`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      setCodeSent(true);
    } catch (err: any) {
      setCodeError(err?.body?.error || err?.message || t("sendCodeError"));
    }
    setSendingCode(false);
  }

  async function verifyCode() {
    if (!/^\d{6}$/.test(code.trim())) { setCodeError(t("codeError")); return; }
    setVerifyingCode(true); setCodeError("");
    try {
      await customFetch(`/api/public/sign/${encodeURIComponent(token)}/verify-code`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      setVerified(true);
    } catch (err: any) {
      setCodeError(err?.body?.error || t("codeError"));
    }
    setVerifyingCode(false);
  }

  async function submitIntake() {
    setSubmitting(true);
    try {
      const effectiveName = intakeNameField ? (intake[intakeNameField.key] || "").trim() : signerName;
      if (intakeNameField && effectiveName !== signerName) setSignerName(effectiveName);
      const intakePayload: Record<string, string> = { ...intake, signerName: effectiveName };
      if (intakeEmailField) intakePayload[intakeEmailField.key] = email.trim();
      await customFetch(`/api/public/sign/${encodeURIComponent(token)}/intake`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ intake: intakePayload }),
      });
      setStep("review");
    } catch (err: any) {
      alert(err?.message || t("saveError"));
    }
    setSubmitting(false);
  }

  async function submitSignature(signaturePngBase64: string) {
    // The edge WAF blocks JSON bodies containing a >~4 KB "data:" URI with an
    // opaque 403 HTML page before the request reaches Express. Always send bare
    // base64 (strip the "data:image/...;base64," prefix); bare base64 passes.
    const bare = signaturePngBase64.includes(",")
      ? signaturePngBase64.slice(signaturePngBase64.indexOf(",") + 1)
      : signaturePngBase64;
    setSubmitting(true);
    try {
      await customFetch(`/api/public/sign/${encodeURIComponent(token)}/sign`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signatureImagePngBase64: bare, signerName }),
      });
      setStep("success");
    } catch (err: any) {
      alert(err?.body?.error || err?.message || t("signError"));
    }
    setSubmitting(false);
  }

  if (step === "loading") {
    return <CenterShell brand={brand}><Loader2 className="w-8 h-8 animate-spin text-primary" /></CenterShell>;
  }
  if (step === "expired") {
    return <CenterShell brand={brand}>
      <AlertCircle className="w-12 h-12 text-amber-500 mb-4" />
      <h1 className="text-xl font-semibold mb-2">{t("expired")}</h1>
      <p className="text-muted-foreground text-sm">{t("expiredBody")}</p>
    </CenterShell>;
  }
  if (step === "revoked") {
    return <CenterShell brand={brand}>
      <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
      <h1 className="text-xl font-semibold mb-2">{t("revoked")}</h1>
      <p className="text-muted-foreground text-sm">{t("revokedBody")}</p>
    </CenterShell>;
  }
  if (step === "error") {
    return <CenterShell brand={brand}>
      <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
      <h1 className="text-xl font-semibold mb-2">{t("error")}</h1>
      <p className="text-muted-foreground text-sm">{errorMsg}</p>
    </CenterShell>;
  }
  if (step === "success") {
    return <CenterShell brand={brand}>
      <CheckCircle2 className="w-14 h-14 text-emerald-500 mb-4" />
      <h1 className="text-2xl font-semibold mb-2">{t("signed")}</h1>
      <p className="text-muted-foreground text-sm text-center max-w-md mb-6">{t("signedBody")}</p>
      <Button
        onClick={handleDownloadPdf}
        disabled={downloadingPdf}
        className="w-full bg-[var(--contract-primary)] hover:opacity-90 text-white"
      >
        {downloadingPdf
          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          : <FileSignature className="w-4 h-4 mr-2" />}
        {t("downloadPdf")}
      </Button>
      {pdfMsg && (
        <p className="text-sm text-muted-foreground text-center mt-3">{pdfMsg}</p>
      )}
    </CenterShell>;
  }

  if (!session) return null;

  const stepLabels = session.mode === "self_fill"
    ? [t("stepIntake"), t("stepReview"), t("stepSign")]
    : [t("stepReview"), t("stepSign")];

  if (step === "intake") {
    const nameOk = intakeNameField
      ? (intake[intakeNameField.key] || "").trim().length > 0
      : signerName.trim().length > 0;
    const canContinue = nameOk && verified;
    const intakeTitle = brand.pageTitle || t("title");
    const intakeSubtitle = brand.pageSubtitle
      ? <span className="font-semibold text-foreground">{brand.pageSubtitle}</span>
      : <>{t("fillDetailsFor")} <span className="font-semibold text-foreground">{session.template.name}</span></>;
    return (
      <Shell
        brand={brand}
        step={1}
        labels={stepLabels}
        title={intakeTitle}
        subtitle={intakeSubtitle}
        footerNote={t("footerNote")}
        footer={
          <Button className="w-full bg-[var(--contract-primary)] hover:opacity-90 text-white" size="lg" onClick={submitIntake} disabled={submitting || !canContinue}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null} {t("continue")}
          </Button>
        }
      >
        <div className="space-y-6">
          {!intakeNameField && (
            <div>
              <FieldLabel required>{t("fullName")}</FieldLabel>
              <Input className="mt-1.5" value={signerName} onChange={e => setSignerName(e.target.value)} required />
            </div>
          )}
          {!intakeEmailField && (
            <EmailVerify
              t={t}
              label={t("emailLabel")}
              email={email}
              onChangeEmail={setEmailValue}
              codeSent={codeSent}
              code={code}
              onChangeCode={setCode}
              verified={verified}
              sendingCode={sendingCode}
              verifyingCode={verifyingCode}
              codeError={codeError}
              onSend={sendCode}
              onVerify={verifyCode}
            />
          )}
          {fields.map(f =>
            intakeEmailField && f.key === intakeEmailField.key ? (
              <EmailVerify
                key={f.key}
                t={t}
                label={f.label}
                email={email}
                onChangeEmail={setEmailValue}
                codeSent={codeSent}
                code={code}
                onChangeCode={setCode}
                verified={verified}
                sendingCode={sendingCode}
                verifyingCode={verifyingCode}
                codeError={codeError}
                onSend={sendCode}
                onVerify={verifyCode}
              />
            ) : (
              <div key={f.key}>
                <FieldLabel required={f.required}>{f.label}</FieldLabel>
                {f.type === "textarea" ? (
                  <Textarea className="mt-1.5" placeholder={f.placeholder} value={intake[f.key] || ""} onChange={e => setIntake(s => ({ ...s, [f.key]: e.target.value }))} rows={3} />
                ) : f.type === "select" ? (
                  <div className="mt-1.5">
                    <SearchableSelect
                      value={intake[f.key] || ""}
                      onValueChange={v => setIntake(s => ({ ...s, [f.key]: v }))}
                      options={((f as any).options || []).map((o: string) => ({ value: o, label: o }))}
                      placeholder={f.placeholder || t("selectPlaceholder")}
                    />
                  </div>
                ) : isYearLikeField(f) ? (
                  <Input
                    className="mt-1.5 bg-muted text-muted-foreground cursor-not-allowed"
                    type="text"
                    value={intake[f.key] || CURRENT_YEAR}
                    readOnly
                    disabled
                    aria-readonly="true"
                  />
                ) : f.type === "tel" ? (
                  <div className="mt-1.5">
                    <PhoneInput
                      value={intake[f.key] || ""}
                      onChange={v => setIntake(s => ({ ...s, [f.key]: v }))}
                    />
                  </div>
                ) : f.type === "country" ? (
                  <div className="mt-1.5">
                    <SearchableSelect
                      value={intake[f.key] || ""}
                      onValueChange={v => {
                        setIntake(s => {
                          const next = { ...s, [f.key]: v };
                          fields.forEach(ff => {
                            if (ff.dependsOn === f.key) next[ff.key] = "";
                          });
                          return next;
                        });
                      }}
                      options={(countryCatalog.length > 0 ? countryCatalog : FALLBACK_COUNTRIES).map(c => ({ value: c, label: c }))}
                      placeholder={f.placeholder || t("selectPlaceholder")}
                    />
                  </div>
                ) : f.type === "city" ? (
                  (() => {
                    const parentCountry = f.dependsOn ? (intake[f.dependsOn] || "") : "";
                    const cityOptions = parentCountry ? (CITIES_BY_COUNTRY[parentCountry] || []) : [];
                    return cityOptions.length > 0 ? (
                      <div className="mt-1.5">
                        <SearchableSelect
                          value={intake[f.key] || ""}
                          onValueChange={v => setIntake(s => ({ ...s, [f.key]: v }))}
                          options={cityOptions.map(c => ({ value: c, label: c }))}
                          placeholder={f.placeholder || t("selectPlaceholder")}
                        />
                      </div>
                    ) : (
                      <Input
                        className="mt-1.5"
                        placeholder={f.placeholder}
                        type="text"
                        value={intake[f.key] || ""}
                        onChange={e => setIntake(s => ({ ...s, [f.key]: e.target.value }))}
                      />
                    );
                  })()
                ) : (
                  <Input
                    className="mt-1.5"
                    placeholder={f.placeholder}
                    type={f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "tel" ? "tel" : "text"}
                    value={intake[f.key] || ""}
                    onChange={e => setIntake(s => ({ ...s, [f.key]: e.target.value }))}
                  />
                )}
              </div>
            )
          )}
        </div>
        {!verified && (
          <p className="text-xs text-muted-foreground mt-4">{t("verifyFirst")}</p>
        )}
      </Shell>
    );
  }

  if (step === "review") {
    return (
      <Shell
        brand={brand}
        step={session.mode === "self_fill" ? 2 : 1}
        labels={stepLabels}
        title={t("titleReview")}
        subtitle={<span className="font-semibold text-foreground">{session.template.name}</span>}
        footer={
          <div className="flex flex-col sm:flex-row-reverse gap-2">
            <Button className="w-full sm:flex-1 bg-[var(--contract-primary)] hover:opacity-90 text-white" size="lg" onClick={() => setStep("sign")}>
              <FileSignature className="w-4 h-4 mr-2" /> {t("sign")}
            </Button>
            {session.mode === "self_fill" && (
              <Button variant="outline" className="w-full sm:w-auto" size="lg" onClick={() => setStep("intake")}>{t("back")}</Button>
            )}
          </div>
        }
      >
        {/*
          The preview is a complete HTML document (the server wraps the rendered
          contract in the SAME document shell used for the final PDF). We load it
          from a dedicated HTML endpoint via the iframe's `src` (NOT srcDoc): a
          srcDoc document INHERITS the parent page's CSP, so in production the
          SPA's strict `style-src 'self'` blocked every inline style and the
          contract rendered completely unstyled. A document fetched from a real
          URL instead carries its OWN response CSP (scoped in the API server to
          allow inline styles while forbidding scripts), so the template's
          <style> blocks and inline CSS render faithfully. sandbox="" keeps the
          preview isolated and prevents any scripts/forms from running.
        */}
        <div className="border rounded-lg overflow-hidden bg-white h-[65vh]">
          <iframe
            title={t("titleReview")}
            sandbox=""
            className="w-full h-full border-0"
            src={previewUrl}
          />
        </div>
      </Shell>
    );
  }

  if (step === "sign") {
    return (
      <Shell
        brand={brand}
        step={session.mode === "self_fill" ? 3 : 2}
        labels={stepLabels}
        title={t("titleSign")}
        subtitle={<span className="font-semibold text-foreground">{session.template.name}</span>}
        footer={
          <div className="flex flex-col sm:flex-row-reverse gap-2">
            <Button
              className="w-full sm:flex-1 bg-[var(--contract-primary)] hover:opacity-90 text-white"
              size="lg"
              onClick={() => sigSubmitRef.current?.()}
              disabled={!verified || !sigReady || !signerName.trim() || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileSignature className="w-4 h-4 mr-2" />} {t("signAndSend")}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" size="lg" onClick={() => setStep("review")}>{t("back")}</Button>
          </div>
        }
      >
        {/* admin_driven sessions skip the intake step, so verification happens
            here. self_fill sessions are already verified by this point.
            For admin_driven, the email is locked to the invited signer's address
            (the backend enforces the same constraint). */}
        {!verified && (
          <div className="mb-4">
            <EmailVerify
              t={t}
              label={intakeEmailField ? intakeEmailField.label : t("emailLabel")}
              email={email}
              onChangeEmail={setEmailValue}
              codeSent={codeSent}
              code={code}
              onChangeCode={setCode}
              verified={verified}
              sendingCode={sendingCode}
              verifyingCode={verifyingCode}
              codeError={codeError}
              onSend={sendCode}
              onVerify={verifyCode}
              emailLocked={session.mode === "admin_driven"}
            />
          </div>
        )}
        <SignaturePad
          onSubmit={submitSignature}
          submitRef={sigSubmitRef}
          onReady={setSigReady}
          signerName={signerName}
          onChangeName={setSignerName}
          t={t}
          showNameInput={!intakeNameField}
        />
      </Shell>
    );
  }

  return null;
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <Label className="text-[var(--contract-primary)] dark:text-foreground font-medium">
      {children}{required ? <span className="text-red-500"> *</span> : null}
    </Label>
  );
}

function BrandHeader({ brand }: { brand: Brand }) {
  const [globalImgError, setGlobalImgError] = useState(false);
  const [customImgError, setCustomImgError] = useState(false);

  // Per-template custom logo takes priority over the global branding logo.
  const customLogoSrc = brand.customLogoUrl && !customImgError ? brand.customLogoUrl : null;
  const globalLogoSrc = !customLogoSrc && brand.hasLogo && !globalImgError
    ? `${BASE_URL}/api/settings/branding/logo?variant=dark`
    : null;
  const logoSrc = customLogoSrc || globalLogoSrc;

  return (
    <div className="text-white" style={{ backgroundColor: brand.primaryColor || "#143591" }}>
      <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-center gap-3">
        {logoSrc ? (
          <img
            src={logoSrc}
            onError={() => { if (customLogoSrc) setCustomImgError(true); else setGlobalImgError(true); }}
            alt={brand.companyName || "Logo"}
            className="h-10 max-w-[220px] object-contain"
          />
        ) : (
          <>
            <div className="w-9 h-9 rounded-lg bg-white/15 flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
            <span className="text-lg font-semibold tracking-tight">{brand.companyName || "Contract Signing"}</span>
          </>
        )}
      </div>
    </div>
  );
}

function CenterShell({ children, brand }: { children: React.ReactNode; brand: Brand }) {
  return (
    <div
      className="min-h-screen bg-secondary/30 flex flex-col"
      style={{ "--contract-primary": brand.primaryColor || "#143591", "--contract-accent": brand.accentColor || brand.primaryColor || "#143591" } as React.CSSProperties}
    >
      <BrandHeader brand={brand} />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-card border rounded-2xl shadow-sm p-10 max-w-md w-full flex flex-col items-center text-center">{children}</div>
      </div>
    </div>
  );
}

function Shell({ subtitle, title, step, labels, brand, children, footer, footerNote }: {
  subtitle: React.ReactNode; title: string; step: number; labels: string[]; brand: Brand;
  children: React.ReactNode; footer?: React.ReactNode; footerNote?: string;
}) {
  return (
    <div
      className="min-h-screen bg-secondary/30 flex flex-col"
      style={{ "--contract-primary": brand.primaryColor || "#143591", "--contract-accent": brand.accentColor || brand.primaryColor || "#143591" } as React.CSSProperties}
    >
      <BrandHeader brand={brand} />
      <div className="flex-1 py-8 px-4">
        <div className="max-w-3xl mx-auto">
          <Stepper step={step} labels={labels} primaryColor={brand.primaryColor || "#143591"} />
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold dark:text-white" style={{ color: brand.primaryColor || "#143591" }}>{title}</h1>
            <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div className="bg-card border rounded-2xl shadow-sm p-6">{children}</div>
        </div>
      </div>
      {footer && (
        <div className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto px-4 py-4">
            {footer}
            {footerNote && <p className="text-center text-xs text-muted-foreground mt-2">{footerNote}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Stepper({ step, labels, primaryColor }: { step: number; labels: string[]; primaryColor: string }) {
  const icons = [Pencil, FileText, PenLine];
  return (
    <div className="flex items-center justify-center mb-8">
      {labels.map((label, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const Icon = icons[i] || Pencil;
        return (
          <div key={label} className="flex items-center">
            {i > 0 && <div className="w-6 sm:w-12 h-px bg-border mx-1.5 sm:mx-3" />}
            <div
              className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "text-white"
                  : done
                  ? "bg-emerald-500 text-white"
                  : "bg-muted text-muted-foreground"
              }`}
              style={active ? { backgroundColor: primaryColor } : undefined}
            >
              {done ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
              <span>{label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmailVerify({
  t, label, email, onChangeEmail, codeSent, code, onChangeCode, verified,
  sendingCode, verifyingCode, codeError, onSend, onVerify, emailLocked,
}: {
  t: Tfn;
  label: string;
  email: string;
  onChangeEmail: (v: string) => void;
  codeSent: boolean;
  code: string;
  onChangeCode: (v: string) => void;
  verified: boolean;
  sendingCode: boolean;
  verifyingCode: boolean;
  codeError: string;
  onSend: () => void;
  onVerify: () => void;
  emailLocked?: boolean;
}) {
  return (
    <div>
      <FieldLabel required>{label}</FieldLabel>
      <Input
        type="email"
        value={email}
        disabled={verified || emailLocked}
        onChange={e => onChangeEmail(e.target.value)}
        placeholder="name@example.com"
        className="mt-1.5"
      />
      <div className="mt-2 rounded-lg border bg-muted/40 px-3 py-2.5">
        {verified ? (
          <div className="flex items-center gap-1.5 text-emerald-600 text-sm font-medium">
            <ShieldCheck className="w-4 h-4" /> {t("verified")}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Mail className="w-4 h-4" />
              <span>{t("emailVerifyRequired")}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSend}
              disabled={sendingCode || !email.trim()}
              className="mt-1 h-auto p-0 font-medium text-[var(--contract-primary)] hover:bg-transparent hover:opacity-80 dark:text-blue-300"
            >
              {sendingCode ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Mail className="w-4 h-4 mr-1.5" />}
              {codeSent ? t("resendCode") : t("sendCode")}
            </Button>

            {codeSent && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-2">{t("codeSentTo", { email })}</p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={e => onChangeCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder={t("enterCode")}
                    className="flex-1 tracking-[0.4em] text-center font-semibold"
                  />
                  <Button
                    type="button"
                    onClick={onVerify}
                    disabled={verifyingCode || code.trim().length !== 6}
                    className="bg-[var(--contract-primary)] hover:opacity-90 text-white"
                  >
                    {verifyingCode ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    {t("verify")}
                  </Button>
                </div>
              </div>
            )}

            {codeError && <p className="text-xs text-red-500 mt-2">{codeError}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function SignaturePad({ onSubmit, submitRef, onReady, signerName, onChangeName, t, showNameInput }: {
  onSubmit: (b64: string) => void;
  submitRef: React.MutableRefObject<(() => void) | null>;
  onReady: (ready: boolean) => void;
  signerName: string;
  onChangeName: (v: string) => void;
  t: Tfn;
  showNameInput: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"draw" | "upload">("draw");
  const [drawing, setDrawing] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [uploaded, setUploaded] = useState<string>("");
  const [uploadError, setUploadError] = useState("");

  useEffect(() => {
    if (mode !== "draw") return;
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * ratio;
    c.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
    setHasInk(false);
  }, [mode]);

  function pointerPos(e: PointerEvent | React.PointerEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: (e as any).clientX - rect.left, y: (e as any).clientY - rect.top };
  }
  function start(e: React.PointerEvent) {
    const c = canvasRef.current!; const ctx = c.getContext("2d")!;
    setDrawing(true);
    const p = pointerPos(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (!drawing) return;
    const c = canvasRef.current!; const ctx = c.getContext("2d")!;
    const p = pointerPos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    setHasInk(true);
  }
  function end() { setDrawing(false); }
  function clear() {
    const c = canvasRef.current!; const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
  }

  function handleFile(file: File | undefined) {
    setUploadError("");
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) { setUploadError(t("sigUploadHint")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 600;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const cx = cv.getContext("2d");
        if (!cx) { setUploadError(t("sigTooLarge")); return; }
        cx.drawImage(img, 0, 0, w, h);
        // Canonical signature format is PNG (the backend validates PNG magic
        // bytes), so never fall back to JPEG here.
        const dataUrl = cv.toDataURL("image/png");
        if (dataUrl.length > MAX_SIG_BASE64) { setUploadError(t("sigTooLarge")); return; }
        setUploaded(dataUrl);
      };
      img.onerror = () => setUploadError(t("sigUploadHint"));
      img.src = reader.result as string;
    };
    reader.onerror = () => setUploadError(t("sigUploadHint"));
    reader.readAsDataURL(file);
  }

  function removeUpload() {
    setUploaded("");
    setUploadError("");
    if (fileRef.current) fileRef.current.value = "";
  }

  function submit() {
    if (mode === "draw") {
      if (!hasInk) return;
      onSubmit(canvasRef.current!.toDataURL("image/png"));
    } else {
      if (!uploaded) return;
      onSubmit(uploaded);
    }
  }

  const hasSignature = mode === "draw" ? hasInk : Boolean(uploaded);

  // Keep the lifted submit handle pointing at the latest closure, and report
  // readiness to the parent so the sticky footer button can enable/submit.
  useEffect(() => {
    submitRef.current = submit;
    return () => { submitRef.current = null; };
  });
  useEffect(() => {
    onReady(hasSignature && confirmed);
    return () => { onReady(false); };
  }, [hasSignature, confirmed, onReady]);

  return (
    <div className="space-y-4">
      {showNameInput && (
        <div>
          <Label className="text-[var(--contract-primary)] dark:text-foreground">{t("fullName")} *</Label>
          <Input value={signerName} onChange={e => onChangeName(e.target.value)} />
        </div>
      )}

      <div>
        <Label className="text-[var(--contract-primary)] dark:text-foreground">{t("signature")}</Label>
        <div className="inline-flex rounded-lg border p-1 bg-muted/40 mt-1 mb-2">
          <button
            type="button"
            onClick={() => setMode("draw")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${mode === "draw" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            <Pencil className="w-3.5 h-3.5" /> {t("sigDraw")}
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${mode === "upload" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            <Upload className="w-3.5 h-3.5" /> {t("sigUpload")}
          </button>
        </div>

        {mode === "draw" ? (
          <>
            <div className="border rounded-lg bg-white relative" style={{ height: 200 }}>
              <canvas
                ref={canvasRef}
                className="w-full h-full touch-none rounded-lg"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
              />
              <button type="button" onClick={clear} className="absolute top-2 right-2 text-xs text-muted-foreground flex items-center gap-1 bg-white/80 px-2 py-1 rounded">
                <Eraser className="w-3 h-3" /> {t("clear")}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("signatureHint")}</p>
          </>
        ) : (
          <>
            {uploaded ? (
              <div className="border rounded-lg bg-white relative flex items-center justify-center p-3" style={{ minHeight: 200 }}>
                <img src={uploaded} alt="signature" className="max-h-[180px] max-w-full object-contain" />
                <button type="button" onClick={removeUpload} className="absolute top-2 right-2 text-xs text-muted-foreground flex items-center gap-1 bg-white/80 px-2 py-1 rounded">
                  <X className="w-3 h-3" /> {t("sigRemove")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed rounded-lg bg-muted/20 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:bg-muted/30 transition-colors"
                style={{ height: 200 }}
              >
                <Upload className="w-6 h-6" />
                <span className="text-sm font-medium">{t("sigChooseFile")}</span>
                <span className="text-xs">{t("sigUploadHint")}</span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
            {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
          </>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />
        <span>{t("consent")}</span>
      </label>
    </div>
  );
}
