import type { EmbedChatLocale } from "./embedChatI18n";

export type EmbedLeadFormCopy = {
  dir: "ltr" | "rtl";
  apply: string;
  intro: string;
  personalInfo: string;
  personalInfoHelp: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  countrySearch: string;
  countryNoMatches: string;
  phonePlaceholder: string;
  phoneInvalid: string;
  submit: string;
  submitting: string;
  cancel: string;
  successTitle: string;
  successText: string;
  requiredAlert: string;
  countryCodeAlert: string;
  latinNameAlert: string;
  submissionFailed: string;
  genericFailed: string;
};

const COPY: Partial<Record<EmbedChatLocale, EmbedLeadFormCopy>> & { en: EmbedLeadFormCopy } = {
  en: { dir: "ltr", apply: "Send your enquiry", intro: "Tell us how to contact you so the right team can respond.", personalInfo: "Contact information", personalInfoHelp: "Provide accurate contact details. They will be used only to respond to this enquiry.", firstName: "First name", lastName: "Last name", email: "Email address", phone: "Phone number", countryCode: "Country code", countrySearch: "Search country or code", countryNoMatches: "No matches", phonePlaceholder: "Phone number", phoneInvalid: "Enter a valid phone number for the selected country.", submit: "Send enquiry", submitting: "Sending…", cancel: "Cancel", successTitle: "Enquiry received", successText: "Thank you. The relevant team will review your details and contact you.", requiredAlert: "Complete all required fields, including the phone country code.", countryCodeAlert: "Select the phone country code.", latinNameAlert: "Enter first and last names with Latin letters.", submissionFailed: "The enquiry could not be sent. Please try again.", genericFailed: "Something went wrong. Please try again." },
  tr: { dir: "ltr", apply: "Talebinizi gönderin", intro: "İlgili ekibin size ulaşabilmesi için iletişim bilgilerinizi yazın.", personalInfo: "İletişim bilgileri", personalInfoHelp: "Doğru iletişim bilgileri girin. Bu bilgiler yalnızca talebinize yanıt vermek için kullanılacaktır.", firstName: "Ad", lastName: "Soyad", email: "E-posta adresi", phone: "Telefon numarası", countryCode: "Ülke kodu", countrySearch: "Ülke veya kod ara", countryNoMatches: "Sonuç bulunamadı", phonePlaceholder: "Telefon numarası", phoneInvalid: "Seçilen ülke için geçerli bir telefon numarası girin.", submit: "Talebi gönder", submitting: "Gönderiliyor…", cancel: "İptal", successTitle: "Talebiniz alındı", successText: "Teşekkürler. İlgili ekip bilgilerinizi inceleyip sizinle iletişime geçecektir.", requiredAlert: "Telefon ülke kodu dâhil tüm zorunlu alanları doldurun.", countryCodeAlert: "Telefon ülke kodunu seçin.", latinNameAlert: "Ad ve soyadı Latin harfleriyle girin.", submissionFailed: "Talep gönderilemedi. Lütfen yeniden deneyin.", genericFailed: "Bir hata oluştu. Lütfen yeniden deneyin." },
  ar: { dir: "rtl", apply: "أرسل طلبك", intro: "أدخل بيانات التواصل كي يرد عليك الفريق المختص.", personalInfo: "معلومات التواصل", personalInfoHelp: "أدخل بيانات دقيقة. ستُستخدم فقط للرد على هذا الطلب.", firstName: "الاسم الأول", lastName: "اسم العائلة", email: "البريد الإلكتروني", phone: "رقم الهاتف", countryCode: "رمز الدولة", countrySearch: "ابحث عن الدولة أو الرمز", countryNoMatches: "لا توجد نتائج", phonePlaceholder: "رقم الهاتف", phoneInvalid: "أدخل رقمًا صالحًا للدولة المختارة.", submit: "إرسال الطلب", submitting: "جارٍ الإرسال…", cancel: "إلغاء", successTitle: "تم استلام الطلب", successText: "شكرًا لك. سيراجع الفريق المختص بياناتك ويتواصل معك.", requiredAlert: "أكمل جميع الحقول المطلوبة، بما فيها رمز الدولة.", countryCodeAlert: "اختر رمز دولة الهاتف.", latinNameAlert: "اكتب الاسم الأول واسم العائلة بالأحرف اللاتينية.", submissionFailed: "تعذر إرسال الطلب. حاول مرة أخرى.", genericFailed: "حدث خطأ. حاول مرة أخرى." },
  fr: { dir: "ltr", apply: "Envoyer votre demande", intro: "Indiquez vos coordonnées afin que l’équipe concernée puisse vous répondre.", personalInfo: "Coordonnées", personalInfoHelp: "Saisissez des informations exactes. Elles serviront uniquement à répondre à cette demande.", firstName: "Prénom", lastName: "Nom", email: "Adresse e-mail", phone: "Numéro de téléphone", countryCode: "Indicatif pays", countrySearch: "Rechercher un pays ou indicatif", countryNoMatches: "Aucun résultat", phonePlaceholder: "Numéro de téléphone", phoneInvalid: "Saisissez un numéro valable pour le pays choisi.", submit: "Envoyer la demande", submitting: "Envoi…", cancel: "Annuler", successTitle: "Demande reçue", successText: "Merci. L’équipe concernée examinera vos informations et vous contactera.", requiredAlert: "Complétez tous les champs obligatoires, y compris l’indicatif.", countryCodeAlert: "Sélectionnez l’indicatif téléphonique.", latinNameAlert: "Saisissez le prénom et le nom en lettres latines.", submissionFailed: "La demande n’a pas pu être envoyée. Réessayez.", genericFailed: "Une erreur s’est produite. Réessayez." },
  ru: { dir: "ltr", apply: "Отправьте запрос", intro: "Укажите контакты, чтобы профильная команда могла ответить.", personalInfo: "Контактные данные", personalInfoHelp: "Введите точные данные. Они будут использованы только для ответа на запрос.", firstName: "Имя", lastName: "Фамилия", email: "Электронная почта", phone: "Номер телефона", countryCode: "Код страны", countrySearch: "Найти страну или код", countryNoMatches: "Ничего не найдено", phonePlaceholder: "Номер телефона", phoneInvalid: "Введите действительный номер для выбранной страны.", submit: "Отправить запрос", submitting: "Отправка…", cancel: "Отмена", successTitle: "Запрос получен", successText: "Спасибо. Профильная команда изучит данные и свяжется с вами.", requiredAlert: "Заполните все обязательные поля, включая код страны.", countryCodeAlert: "Выберите телефонный код страны.", latinNameAlert: "Введите имя и фамилию латинскими буквами.", submissionFailed: "Не удалось отправить запрос. Попробуйте еще раз.", genericFailed: "Произошла ошибка. Попробуйте еще раз." },
  fa: { dir: "rtl", apply: "درخواست خود را بفرستید", intro: "اطلاعات تماس را وارد کنید تا تیم مربوط پاسخ دهد.", personalInfo: "اطلاعات تماس", personalInfoHelp: "اطلاعات دقیق وارد کنید. این داده‌ها فقط برای پاسخ به درخواست استفاده می‌شوند.", firstName: "نام", lastName: "نام خانوادگی", email: "نشانی ایمیل", phone: "شماره تلفن", countryCode: "کد کشور", countrySearch: "جستجوی کشور یا کد", countryNoMatches: "نتیجه‌ای نیست", phonePlaceholder: "شماره تلفن", phoneInvalid: "برای کشور انتخاب‌شده شماره معتبر وارد کنید.", submit: "ارسال درخواست", submitting: "در حال ارسال…", cancel: "لغو", successTitle: "درخواست دریافت شد", successText: "سپاسگزاریم. تیم مربوط اطلاعات را بررسی و با شما تماس می‌گیرد.", requiredAlert: "همه موارد ضروری، از جمله کد کشور تلفن، را کامل کنید.", countryCodeAlert: "کد کشور تلفن را انتخاب کنید.", latinNameAlert: "نام و نام خانوادگی را با حروف لاتین وارد کنید.", submissionFailed: "درخواست ارسال نشد. دوباره تلاش کنید.", genericFailed: "خطایی رخ داد. دوباره تلاش کنید." },
};

export function getEmbedLeadFormCopy(locale: EmbedChatLocale): EmbedLeadFormCopy {
  return COPY[locale] ?? COPY.en;
}
