import type { BotLanguage } from "./inbox/botBrain";

export const EMBED_CHAT_LOCALES = [
  "en",
  "tr",
  "ar",
  "fa",
  "fr",
  "es",
  "ru",
  "zh",
  "hi",
  "id",
] as const satisfies readonly BotLanguage[];

export type EmbedChatLocale = (typeof EMBED_CHAT_LOCALES)[number];

const SUPPORTED = new Set<string>(EMBED_CHAT_LOCALES);

/**
 * Convert a BCP-47 language, an Accept-Language value, or a short application
 * locale into one of the ten locales supported by the public chat widget.
 */
export function normalizeEmbedChatLocale(value: unknown): EmbedChatLocale | null {
  if (typeof value !== "string") return null;
  const first = value.trim().toLowerCase().split(",")[0]?.split(";")[0]?.trim();
  if (!first) return null;
  const base = first.replace(/_/g, "-").split("-")[0];
  return SUPPORTED.has(base) ? base as EmbedChatLocale : null;
}

export function localeFromPublicUrl(value: unknown): EmbedChatLocale | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const firstPathPart = new URL(value).pathname.split("/").filter(Boolean)[0];
    return normalizeEmbedChatLocale(firstPathPart);
  } catch {
    return null;
  }
}

export function resolveEmbedChatLocale(
  ...candidates: unknown[]
): EmbedChatLocale {
  for (const candidate of candidates) {
    const locale = normalizeEmbedChatLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

export type EmbedChatCopy = {
  dir: "ltr" | "rtl";
  assistantName: (universityName: string) => string;
  headerSub: string;
  launcherLabel: string;
  handoffLabel: string;
  closeLabel: string;
  hello: string;
  intro: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  countrySearch: string;
  countryNoMatches: string;
  phonePlaceholder: string;
  phoneInvalid: string;
  startChat: string;
  typing: string;
  messagePlaceholder: string;
  send: string;
  genericError: string;
  startError: string;
  sendError: string;
  enterContactFirst: string;
  humanNotified: string;
  sentToTeam: string;
  handoffSent: string;
  handoffError: string;
  greeting: (firstName: string, universityName: string) => string;
  handoffStaffEvent: string;
};

const COPY: Record<EmbedChatLocale, EmbedChatCopy> = {
  en: {
    dir: "ltr",
    assistantName: (u) => `${u} Authorized Representative Application Assistant`,
    headerSub: "Online • Secure application support",
    launcherLabel: "Open application assistant",
    handoffLabel: "Request a human advisor",
    closeLabel: "Close",
    hello: "Hello 👋",
    intro: "Enter your contact details so we can provide the right application support.",
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone (with country code)",
    countryCode: "Country code",
    countrySearch: "Search country or code",
    countryNoMatches: "No matches",
    phonePlaceholder: "Phone number",
    phoneInvalid: "Select a country code and enter a valid phone number.",
    startChat: "Start chat",
    typing: "Assistant is typing…",
    messagePlaceholder: "Type your message...",
    send: "Send",
    genericError: "The operation could not be completed",
    startError: "The chat could not be started",
    sendError: "The message could not be sent",
    enterContactFirst: "Enter your contact details first.",
    humanNotified: "A human advisor has been notified.",
    sentToTeam: "Your message was sent to the team. An advisor will reply.",
    handoffSent: "Your request for a human advisor was sent to the team.",
    handoffError: "The request could not be sent",
    greeting: (name, u) => `Hello ${name}, I can help with your ${u} application. Which program and study level are you interested in?`,
    handoffStaffEvent: "The visitor would like to speak with a human advisor.",
  },
  tr: {
    dir: "ltr",
    assistantName: (u) => `${u} Yetkili Temsilci Başvuru Asistanı`,
    headerSub: "Çevrimiçi • Güvenli başvuru desteği",
    launcherLabel: "Başvuru asistanını aç",
    handoffLabel: "İnsan danışman iste",
    closeLabel: "Kapat",
    hello: "Merhaba 👋",
    intro: "Size doğru başvuru desteğini verebilmemiz için iletişim bilgilerinizi girin.",
    firstName: "Ad",
    lastName: "Soyad",
    email: "E-posta",
    phone: "Telefon (ülke koduyla)",
    countryCode: "Ülke kodu",
    countrySearch: "Ülke veya kod ara",
    countryNoMatches: "Eşleşme bulunamadı",
    phonePlaceholder: "Telefon numarası",
    phoneInvalid: "Ülke kodunu seçin ve geçerli bir telefon numarası girin.",
    startChat: "Sohbeti başlat",
    typing: "Asistan yazıyor…",
    messagePlaceholder: "Mesajınızı yazın...",
    send: "Gönder",
    genericError: "İşlem tamamlanamadı",
    startError: "Sohbet başlatılamadı",
    sendError: "Mesaj gönderilemedi",
    enterContactFirst: "Önce iletişim bilgilerinizi girin.",
    humanNotified: "Bir insan danışman bilgilendirildi.",
    sentToTeam: "Mesajınız ekibe iletildi. Bir danışman yanıtlayacak.",
    handoffSent: "İnsan danışman talebiniz ekibe iletildi.",
    handoffError: "Talep iletilemedi",
    greeting: (name, u) => `Merhaba ${name}, ${u} başvurunuz için size yardımcı olabilirim. Hangi bölüm ve eğitim seviyesiyle ilgileniyorsunuz?`,
    handoffStaffEvent: "Ziyaretçi bir insan danışmanla görüşmek istiyor.",
  },
  ar: {
    dir: "rtl",
    assistantName: (u) => `مساعد التقديم للممثل المعتمد لجامعة ${u}`,
    headerSub: "متصل • دعم تقديم آمن",
    launcherLabel: "فتح مساعد التقديم",
    handoffLabel: "طلب مستشار بشري",
    closeLabel: "إغلاق",
    hello: "مرحباً 👋",
    intro: "أدخل بيانات التواصل لنقدم لك دعم التقديم المناسب.",
    firstName: "الاسم الأول",
    lastName: "اسم العائلة",
    email: "البريد الإلكتروني",
    phone: "الهاتف (مع رمز الدولة)",
    countryCode: "رمز الدولة",
    countrySearch: "ابحث عن دولة أو رمز",
    countryNoMatches: "لا توجد نتائج",
    phonePlaceholder: "رقم الهاتف",
    phoneInvalid: "اختر رمز الدولة وأدخل رقم هاتف صالحًا.",
    startChat: "ابدأ المحادثة",
    typing: "المساعد يكتب…",
    messagePlaceholder: "اكتب رسالتك...",
    send: "إرسال",
    genericError: "تعذر إكمال العملية",
    startError: "تعذر بدء المحادثة",
    sendError: "تعذر إرسال الرسالة",
    enterContactFirst: "أدخل بيانات التواصل أولاً.",
    humanNotified: "تم إبلاغ مستشار بشري.",
    sentToTeam: "تم إرسال رسالتك إلى الفريق. سيرد عليك مستشار.",
    handoffSent: "تم إرسال طلبك للتحدث مع مستشار بشري.",
    handoffError: "تعذر إرسال الطلب",
    greeting: (name, u) => `مرحباً ${name}، يمكنني مساعدتك في التقديم إلى ${u}. ما البرنامج والمستوى الدراسي الذي تهتم به؟`,
    handoffStaffEvent: "يرغب الزائر في التحدث مع مستشار بشري.",
  },
  fa: {
    dir: "rtl",
    assistantName: (u) => `دستیار درخواست نماینده مجاز دانشگاه ${u}`,
    headerSub: "آنلاین • پشتیبانی امن درخواست",
    launcherLabel: "باز کردن دستیار درخواست",
    handoffLabel: "درخواست مشاور انسانی",
    closeLabel: "بستن",
    hello: "سلام 👋",
    intro: "اطلاعات تماس خود را وارد کنید تا پشتیبانی مناسب درخواست را ارائه دهیم.",
    firstName: "نام",
    lastName: "نام خانوادگی",
    email: "ایمیل",
    phone: "تلفن (با کد کشور)",
    countryCode: "کد کشور",
    countrySearch: "جستجوی کشور یا کد",
    countryNoMatches: "نتیجه‌ای یافت نشد",
    phonePlaceholder: "شماره تلفن",
    phoneInvalid: "کد کشور را انتخاب کنید و شماره تلفن معتبر وارد کنید.",
    startChat: "شروع گفتگو",
    typing: "دستیار در حال نوشتن است…",
    messagePlaceholder: "پیام خود را بنویسید...",
    send: "ارسال",
    genericError: "عملیات انجام نشد",
    startError: "گفتگو شروع نشد",
    sendError: "پیام ارسال نشد",
    enterContactFirst: "ابتدا اطلاعات تماس خود را وارد کنید.",
    humanNotified: "یک مشاور انسانی مطلع شد.",
    sentToTeam: "پیام شما برای تیم ارسال شد. یک مشاور پاسخ خواهد داد.",
    handoffSent: "درخواست مشاور انسانی برای تیم ارسال شد.",
    handoffError: "درخواست ارسال نشد",
    greeting: (name, u) => `سلام ${name}، می‌توانم برای درخواست شما به ${u} کمک کنم. به کدام رشته و مقطع تحصیلی علاقه دارید؟`,
    handoffStaffEvent: "بازدیدکننده می‌خواهد با یک مشاور انسانی صحبت کند.",
  },
  fr: {
    dir: "ltr",
    assistantName: (u) => `Assistant de candidature du représentant agréé de ${u}`,
    headerSub: "En ligne • Assistance sécurisée",
    launcherLabel: "Ouvrir l’assistant de candidature",
    handoffLabel: "Demander un conseiller",
    closeLabel: "Fermer",
    hello: "Bonjour 👋",
    intro: "Saisissez vos coordonnées afin que nous puissions vous fournir l’aide adaptée.",
    firstName: "Prénom",
    lastName: "Nom",
    email: "E-mail",
    phone: "Téléphone (avec indicatif pays)",
    countryCode: "Indicatif",
    countrySearch: "Rechercher un pays ou un indicatif",
    countryNoMatches: "Aucun résultat",
    phonePlaceholder: "Numéro de téléphone",
    phoneInvalid: "Sélectionnez un indicatif et saisissez un numéro valide.",
    startChat: "Démarrer le chat",
    typing: "L’assistant écrit…",
    messagePlaceholder: "Écrivez votre message...",
    send: "Envoyer",
    genericError: "L’opération n’a pas pu être effectuée",
    startError: "Le chat n’a pas pu démarrer",
    sendError: "Le message n’a pas pu être envoyé",
    enterContactFirst: "Saisissez d’abord vos coordonnées.",
    humanNotified: "Un conseiller humain a été informé.",
    sentToTeam: "Votre message a été transmis à l’équipe. Un conseiller vous répondra.",
    handoffSent: "Votre demande de conseiller humain a été transmise.",
    handoffError: "La demande n’a pas pu être envoyée",
    greeting: (name, u) => `Bonjour ${name}, je peux vous aider pour votre candidature à ${u}. Quel programme et quel niveau d’études vous intéressent ?`,
    handoffStaffEvent: "Le visiteur souhaite parler à un conseiller humain.",
  },
  es: {
    dir: "ltr",
    assistantName: (u) => `Asistente de solicitud del representante autorizado de ${u}`,
    headerSub: "En línea • Asistencia segura",
    launcherLabel: "Abrir el asistente de solicitud",
    handoffLabel: "Solicitar un asesor",
    closeLabel: "Cerrar",
    hello: "Hola 👋",
    intro: "Introduce tus datos de contacto para que podamos ofrecerte la ayuda adecuada.",
    firstName: "Nombre",
    lastName: "Apellido",
    email: "Correo electrónico",
    phone: "Teléfono (con código de país)",
    countryCode: "Código de país",
    countrySearch: "Buscar país o código",
    countryNoMatches: "Sin resultados",
    phonePlaceholder: "Número de teléfono",
    phoneInvalid: "Selecciona un código de país e introduce un número válido.",
    startChat: "Iniciar chat",
    typing: "El asistente está escribiendo…",
    messagePlaceholder: "Escribe tu mensaje...",
    send: "Enviar",
    genericError: "No se pudo completar la operación",
    startError: "No se pudo iniciar el chat",
    sendError: "No se pudo enviar el mensaje",
    enterContactFirst: "Introduce primero tus datos de contacto.",
    humanNotified: "Se ha avisado a un asesor.",
    sentToTeam: "Tu mensaje fue enviado al equipo. Un asesor responderá.",
    handoffSent: "Tu solicitud para hablar con un asesor fue enviada.",
    handoffError: "No se pudo enviar la solicitud",
    greeting: (name, u) => `Hola ${name}, puedo ayudarte con tu solicitud a ${u}. ¿Qué programa y nivel de estudios te interesan?`,
    handoffStaffEvent: "El visitante desea hablar con un asesor humano.",
  },
  ru: {
    dir: "ltr",
    assistantName: (u) => `Ассистент по поступлению уполномоченного представителя ${u}`,
    headerSub: "Онлайн • Безопасная поддержка",
    launcherLabel: "Открыть ассистента по поступлению",
    handoffLabel: "Запросить консультанта",
    closeLabel: "Закрыть",
    hello: "Здравствуйте 👋",
    intro: "Введите контактные данные, чтобы мы могли оказать подходящую поддержку.",
    firstName: "Имя",
    lastName: "Фамилия",
    email: "Эл. почта",
    phone: "Телефон (с кодом страны)",
    countryCode: "Код страны",
    countrySearch: "Поиск страны или кода",
    countryNoMatches: "Совпадений нет",
    phonePlaceholder: "Номер телефона",
    phoneInvalid: "Выберите код страны и введите корректный номер телефона.",
    startChat: "Начать чат",
    typing: "Ассистент печатает…",
    messagePlaceholder: "Введите сообщение...",
    send: "Отправить",
    genericError: "Не удалось выполнить операцию",
    startError: "Не удалось начать чат",
    sendError: "Не удалось отправить сообщение",
    enterContactFirst: "Сначала введите контактные данные.",
    humanNotified: "Консультант был уведомлён.",
    sentToTeam: "Сообщение передано команде. Консультант ответит вам.",
    handoffSent: "Запрос на связь с консультантом отправлен.",
    handoffError: "Не удалось отправить запрос",
    greeting: (name, u) => `Здравствуйте, ${name}! Я помогу вам с поступлением в ${u}. Какая программа и уровень обучения вас интересуют?`,
    handoffStaffEvent: "Посетитель хочет поговорить с консультантом.",
  },
  zh: {
    dir: "ltr",
    assistantName: (u) => `${u}授权代表申请助手`,
    headerSub: "在线 • 安全申请支持",
    launcherLabel: "打开申请助手",
    handoffLabel: "请求人工顾问",
    closeLabel: "关闭",
    hello: "您好 👋",
    intro: "请输入您的联系方式，以便我们提供合适的申请支持。",
    firstName: "名",
    lastName: "姓",
    email: "电子邮箱",
    phone: "电话（含国家代码）",
    countryCode: "国家代码",
    countrySearch: "搜索国家或代码",
    countryNoMatches: "未找到匹配项",
    phonePlaceholder: "电话号码",
    phoneInvalid: "请选择国家代码并输入有效的电话号码。",
    startChat: "开始聊天",
    typing: "助手正在输入…",
    messagePlaceholder: "请输入消息...",
    send: "发送",
    genericError: "无法完成操作",
    startError: "无法开始聊天",
    sendError: "无法发送消息",
    enterContactFirst: "请先输入您的联系方式。",
    humanNotified: "人工顾问已收到通知。",
    sentToTeam: "您的消息已发送给团队，顾问将回复您。",
    handoffSent: "您的人工顾问请求已发送。",
    handoffError: "无法发送请求",
    greeting: (name, u) => `您好，${name}！我可以协助您申请${u}。您对哪个专业和学习阶段感兴趣？`,
    handoffStaffEvent: "访客希望与人工顾问交谈。",
  },
  hi: {
    dir: "ltr",
    assistantName: (u) => `${u} अधिकृत प्रतिनिधि आवेदन सहायक`,
    headerSub: "ऑनलाइन • सुरक्षित आवेदन सहायता",
    launcherLabel: "आवेदन सहायक खोलें",
    handoffLabel: "मानव सलाहकार का अनुरोध करें",
    closeLabel: "बंद करें",
    hello: "नमस्ते 👋",
    intro: "सही आवेदन सहायता के लिए अपनी संपर्क जानकारी दर्ज करें।",
    firstName: "पहला नाम",
    lastName: "उपनाम",
    email: "ईमेल",
    phone: "फ़ोन (देश कोड सहित)",
    countryCode: "देश कोड",
    countrySearch: "देश या कोड खोजें",
    countryNoMatches: "कोई परिणाम नहीं",
    phonePlaceholder: "फ़ोन नंबर",
    phoneInvalid: "देश कोड चुनें और मान्य फ़ोन नंबर दर्ज करें।",
    startChat: "चैट शुरू करें",
    typing: "सहायक लिख रहा है…",
    messagePlaceholder: "अपना संदेश लिखें...",
    send: "भेजें",
    genericError: "प्रक्रिया पूरी नहीं हो सकी",
    startError: "चैट शुरू नहीं हो सकी",
    sendError: "संदेश नहीं भेजा जा सका",
    enterContactFirst: "पहले अपनी संपर्क जानकारी दर्ज करें।",
    humanNotified: "एक मानव सलाहकार को सूचित कर दिया गया है।",
    sentToTeam: "आपका संदेश टीम को भेज दिया गया है। एक सलाहकार उत्तर देगा।",
    handoffSent: "मानव सलाहकार के लिए आपका अनुरोध भेज दिया गया है।",
    handoffError: "अनुरोध नहीं भेजा जा सका",
    greeting: (name, u) => `नमस्ते ${name}, मैं ${u} में आपके आवेदन में सहायता कर सकता हूँ। आप किस कार्यक्रम और अध्ययन स्तर में रुचि रखते हैं?`,
    handoffStaffEvent: "आगंतुक मानव सलाहकार से बात करना चाहता है।",
  },
  id: {
    dir: "ltr",
    assistantName: (u) => `Asisten Pendaftaran Perwakilan Resmi ${u}`,
    headerSub: "Online • Dukungan pendaftaran aman",
    launcherLabel: "Buka asisten pendaftaran",
    handoffLabel: "Minta penasihat manusia",
    closeLabel: "Tutup",
    hello: "Halo 👋",
    intro: "Masukkan detail kontak agar kami dapat memberikan dukungan pendaftaran yang tepat.",
    firstName: "Nama depan",
    lastName: "Nama belakang",
    email: "Email",
    phone: "Telepon (dengan kode negara)",
    countryCode: "Kode negara",
    countrySearch: "Cari negara atau kode",
    countryNoMatches: "Tidak ada hasil",
    phonePlaceholder: "Nomor telepon",
    phoneInvalid: "Pilih kode negara dan masukkan nomor telepon yang valid.",
    startChat: "Mulai chat",
    typing: "Asisten sedang mengetik…",
    messagePlaceholder: "Tulis pesan Anda...",
    send: "Kirim",
    genericError: "Proses tidak dapat diselesaikan",
    startError: "Chat tidak dapat dimulai",
    sendError: "Pesan tidak dapat dikirim",
    enterContactFirst: "Masukkan detail kontak terlebih dahulu.",
    humanNotified: "Penasihat manusia telah diberi tahu.",
    sentToTeam: "Pesan Anda dikirim ke tim. Seorang penasihat akan membalas.",
    handoffSent: "Permintaan penasihat manusia telah dikirim.",
    handoffError: "Permintaan tidak dapat dikirim",
    greeting: (name, u) => `Halo ${name}, saya dapat membantu pendaftaran Anda ke ${u}. Program dan jenjang studi apa yang Anda minati?`,
    handoffStaffEvent: "Pengunjung ingin berbicara dengan penasihat manusia.",
  },
};

export function getEmbedChatCopy(locale: EmbedChatLocale): EmbedChatCopy {
  return COPY[locale] ?? COPY.en;
}
