export interface LocalizableNotification {
  type?: string | null;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
}

interface OfferExpiryCopy {
  offerLetter: string;
  title: (stage: string, days: number) => string;
  body: (subject: string, stage: string, date: string, days: number) => string;
}

const DATE_LOCALES: Record<string, string> = {
  en: "en-US", tr: "tr-TR", ar: "ar-SA", fa: "fa-IR", fr: "fr-FR",
  es: "es-ES", ru: "ru-RU", zh: "zh-CN", hi: "hi-IN", id: "id-ID",
};

const COPY: Record<string, OfferExpiryCopy> = {
  en: {
    offerLetter: "Offer Letter",
    title: (stage, days) => `${stage} expires in ${days} day${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject}: the ${stage} document is valid until ${date} (${days} day${days === 1 ? "" : "s"} left).`,
  },
  tr: {
    offerLetter: "Teklif Mektubu",
    title: (stage, days) => `${stage} ${days} gün içinde geçerliliğini yitiriyor`,
    body: (subject, stage, date, days) => `${subject}: ${stage} belgesinin son geçerlilik tarihi ${date} (${days} gün kaldı).`,
  },
  ar: {
    offerLetter: "خطاب القبول",
    title: (stage, days) => `تنتهي صلاحية ${stage} خلال ${days} يومًا`,
    body: (subject, stage, date, days) => `${subject}: وثيقة ${stage} صالحة حتى ${date} (متبقي ${days} يومًا).`,
  },
  fa: {
    offerLetter: "نامه پذیرش",
    title: (stage, days) => `اعتبار ${stage} تا ${days} روز دیگر پایان می‌یابد`,
    body: (subject, stage, date, days) => `${subject}: مدرک ${stage} تا ${date} معتبر است (${days} روز باقی مانده).`,
  },
  fr: {
    offerLetter: "Lettre d’admission",
    title: (stage, days) => `${stage} expire dans ${days} jour${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject} : le document ${stage} est valable jusqu’au ${date} (${days} jour${days === 1 ? "" : "s"} restant${days === 1 ? "" : "s"}).`,
  },
  es: {
    offerLetter: "Carta de admisión",
    title: (stage, days) => `${stage} vence en ${days} día${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject}: el documento ${stage} es válido hasta el ${date} (quedan ${days} día${days === 1 ? "" : "s"}).`,
  },
  ru: {
    offerLetter: "Письмо о зачислении",
    title: (stage, days) => `Срок действия «${stage}» истекает через ${days} дн.`,
    body: (subject, stage, date, days) => `${subject}: документ «${stage}» действителен до ${date} (осталось ${days} дн.).`,
  },
  zh: {
    offerLetter: "录取通知书",
    title: (stage, days) => `${stage}将在 ${days} 天后到期`,
    body: (subject, stage, date, days) => `${subject}：${stage}有效期至 ${date}（剩余 ${days} 天）。`,
  },
  hi: {
    offerLetter: "प्रवेश पत्र",
    title: (stage, days) => `${stage} की वैधता ${days} दिन में समाप्त होगी`,
    body: (subject, stage, date, days) => `${subject}: ${stage} दस्तावेज़ ${date} तक वैध है (${days} दिन शेष)।`,
  },
  id: {
    offerLetter: "Surat Penerimaan",
    title: (stage, days) => `${stage} akan kedaluwarsa dalam ${days} hari`,
    body: (subject, stage, date, days) => `${subject}: dokumen ${stage} berlaku hingga ${date} (${days} hari tersisa).`,
  },
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatLocalizedDate(value: unknown, lang: string): string {
  const date = new Date(asText(value));
  if (Number.isNaN(date.getTime())) return asText(value);
  return new Intl.DateTimeFormat(DATE_LOCALES[lang] || DATE_LOCALES.en, {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function isOfferLetterStage(data: Record<string, unknown>): boolean {
  const stage = `${asText(data.stage)} ${asText(data.stageLabel)}`.toLocaleLowerCase("en-US");
  return stage.includes("offer") || stage.includes("acceptance") || stage.includes("admission");
}

export function localizeNotification(
  notification: LocalizableNotification,
  requestedLanguage: string,
): { title: string; body: string | null } {
  const fallback = {
    title: notification.title || "",
    body: notification.body || null,
  };
  if (notification.type !== "application.offer_letter_expiring") return fallback;

  const lang = COPY[requestedLanguage] ? requestedLanguage : "en";
  const copy = COPY[lang];
  const data = notification.data && typeof notification.data === "object" ? notification.data : {};
  const days = Number(data.daysLeft);
  const date = formatLocalizedDate(data.validUntil, lang);
  if (!Number.isFinite(days) || !date) return fallback;

  const storedStageLabel = asText(data.stageLabel);
  const stage = isOfferLetterStage(data) ? copy.offerLetter : (storedStageLabel || copy.offerLetter);
  const studentName = asText(data.studentName);
  const universityName = asText(data.universityName);
  const programName = asText(data.programName);
  const institution = [universityName, programName].filter(Boolean).join(" / ");
  const subject = [studentName, institution].filter(Boolean).join(" — ") || stage;

  return {
    title: copy.title(stage, days),
    body: copy.body(subject, stage, date, days),
  };
}
