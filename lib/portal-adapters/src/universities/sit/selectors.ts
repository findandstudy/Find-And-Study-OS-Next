// ---------------------------------------------------------------------------
// SIT portal — centralized selectors
//
// All locators for the SIT (partners.sitconnect.net) agency panel live here so
// the adapter logic stays free of inline CSS/role strings. Locators are
// expressed as role-name / placeholder / label regexes (resilient to copy
// changes and i18n EN↔TR) with CSS fallbacks where a stable attribute exists.
//
// These are plain data constants (strings / RegExp) so they can be unit-tested
// for presence without launching a browser.
// ---------------------------------------------------------------------------

export const SIT_URLS = {
  /** Portal origin — used for navigation and the GraphQL endpoint. */
  base: "https://partners.sitconnect.net",
  /** Login route. A redirect here mid-session means the auth cookie expired. */
  loginPath: "/auth/login",
  /** Student list / search route. */
  studentsPath: "/students",
  /** Application list route — hosts the "Add Application" modal. */
  applicationsPath: "/applications",
} as const;

export const SIT_LOGIN = {
  /** Candidate selectors for the username/email input (first visible wins). */
  emailCandidates: [
    "input[type=email]",
    "input[name*=email i]",
    "input[placeholder*=mail i]",
    "input[name*=user i]",
    "input[type=text]",
  ],
  /** Password input. */
  passwordCandidates: ["input[type=password]"],
  /** Submit button accessible-name. */
  submitName: /sign ?in|log ?in|giri[sş]/i,
  /** A logged-in URL never contains the login path. */
  loginUrlMarker: /\/auth\/login/i,
} as const;

export const SIT_NAV = {
  /** "Add Student" entry button. */
  addStudentName: /add student|new student|öğrenci ekle|yeni öğrenci/i,
  /** "Add Application" button on the student detail page / dialog. */
  addApplicationName: /add application|new application|başvuru ekle/i,
  /** Student-list search box. */
  searchPlaceholder: /search by name|name or email|search|ara/i,
  /** Row affordance that opens the student detail page. */
  rowInfoSelector: ".lucide-info",
  /** URL pattern of a resolved student detail page (id segment). */
  studentDetailUrl: /\/students\/[0-9a-z-]+/i,
} as const;

// ---------------------------------------------------------------------------
// 6-step "Add Student" wizard — field label/placeholder matchers.
//
// Step grouping (for logging / progression):
//   1. Personal   — first/last name, DOB, gender
//   2. Contact    — email, phone, address
//   3. Family     — father/mother name
//   4. Identity   — nationality, passport
//   5. Academics  — school, GPA, graduation, level
//   6. Documents  — photo + attachments (filechooser uploads)
// ---------------------------------------------------------------------------
export const SIT_STUDENT_FIELDS = {
  firstName:      /first name|given name|^ad[ıi]?\b|isim/i,
  lastName:       /last name|surname|family name|soyad/i,
  email:          /e-?mail/i,
  phone:          /phone|mobile|telefon|gsm/i,
  dateOfBirth:    /date of birth|birth date|doğum tarihi|\bdob\b/i,
  gender:         /gender|cinsiyet/i,
  nationality:    /nationality|citizenship|uyruk|vatanda/i,
  passportNumber: /passport(\s*(no|number))?|pasaport/i,
  fatherName:     /father'?s?\s*name|baba ad/i,
  motherName:     /mother'?s?\s*name|anne ad/i,
  address:        /address|adres/i,
  // Contact & Location "City" — anchored so it never matches "Capacity" etc.
  city:           /^\s*city\b|şehir|sehir|^\s*il\b/i,
  // Contact & Location "Country" (country of residence). Anchored so it never
  // matches "Nationality" and excludes a phone "Country Code" control.
  country:        /^\s*country\b(?!\s*code)|ikamet.*ülke|^\s*ülke\b/i,
  schoolName:     /school name|high school|lise|okul ad/i,
  gpa:            /\bgpa\b|grade point|not ortalama|diploma (notu|grade)/i,
  graduationYear: /graduation (year|date)|mezuniyet (yıl|tarih)/i,
  passportIssueDate:  /passport (issue|issued)|issue date|veriliş|düzenlen/i,
  passportExpiryDate: /passport expiry|expiry date|expiration|son (geçerlilik|kullanma)|geçerlilik/i,
  tcNumber:       /tc (number|no|kimlik (no|numaras))|t\.?c\.? (kimlik|no)|kimlik numaras/i,
} as const;

export type SitStudentFieldKey = keyof typeof SIT_STUDENT_FIELDS;

// ---------------------------------------------------------------------------
// Yes/No toggle fields (rendered as radios or a custom combobox). "apply" has
// no TC / transfer-student data, so both default to "No".
// ---------------------------------------------------------------------------
export const SIT_TOGGLES = {
  // "Have T.C" renders with a dot, so `have\s*tc` never matched it — allow the
  // optional dots/spaces between the letters.
  haveTc:          /have\s*t\.?\s*c\.?|t\.?\s*c\.?\s*(kimlik|var|numaras)|tc kimlik/i,
  transferStudent: /transfer student|yatay geçiş|transfer öğrenci/i,
  /** "Blue Card" residency question — foreign applicants default to No. */
  blueCard:        /blue\s*card|mavi kart/i,
  /** Affirmative option matcher (radio/option label). */
  yesOption:       /^\s*(yes|evet)\s*$/i,
  /** Negative option matcher (radio/option label). */
  noOption:        /^\s*(no|hayır|hayir)\s*$/i,
} as const;

// ---------------------------------------------------------------------------
// "Add Application" dialog — combobox trigger matchers.
// SIT renders custom comboboxes as a role=button that opens a role=listbox of
// role=option items (not native <select>).
// ---------------------------------------------------------------------------
export const SIT_APP_FIELDS = {
  student:      /select student|student|öğrenci/i,
  academicYear: /academic year|year|akademik yıl/i,
  semester:     /semester|intake|term|dönem/i,
  country:      /select country|country|ülke/i,
  university:   /select university|university|üniversite/i,
  degree:       /select degree|degree|level|derece/i,
  program:      /select program|program|bölüm/i,
} as const;

export type SitAppFieldKey = keyof typeof SIT_APP_FIELDS;

// ---------------------------------------------------------------------------
// Button accessible-name matchers.
// ---------------------------------------------------------------------------
export const SIT_BUTTONS = {
  next:              /^\s*(next|continue|ileri|devam|kaydet ve devam)\s*$/i,
  back:              /^\s*(back|previous|geri)\s*$/i,
  saveStudent:       /save( student)?|create student|kaydet|tamamla|öğrenciyi kaydet/i,
  addApplication:    /add application|new application|başvuru ekle/i,
  createApplication: /create application|save application|submit|başvuru oluştur/i,
} as const;

export type SitButtonKey = keyof typeof SIT_BUTTONS;

// ---------------------------------------------------------------------------
// Document upload triggers — clicking these opens the OS file chooser, which we
// intercept via page.waitForEvent("filechooser") (no reliance on a DOM
// input[type=file], which SIT hides behind a styled button).
// ---------------------------------------------------------------------------
export const SIT_UPLOAD = {
  photoTrigger:      /upload (photo|image)|profile (photo|image)|choose (image|photo)|fotoğraf|resim/i,
  attachmentTrigger: /upload|attach|browse|choose file|add (new )?doc|dosya|belge (ekle|yükle)/i,
  /**
   * Per-document upload triggers — the Documents step exposes a distinct
   * file-chooser per attachment type. Tried before the generic attachmentTrigger
   * so each local file lands in its own slot; falls back to the generic trigger
   * (then the hidden input) when no type-specific button exists.
   */
  passportTrigger:   /passport|pasaport/i,
  transcriptTrigger: /transcript|marks?\s*(sheet|card)?|result|grade|hsc|not döküm|transkript/i,
  diplomaTrigger:    /diploma|degree|certificate|graduation|mezuniyet|sertifika/i,
  /** Generic hidden file input fallback if a filechooser does not appear. */
  fileInput: "input[type=file]",
} as const;

// ---------------------------------------------------------------------------
// "Session Inactivity Warning" modal — SIT pops this after idle time while the
// wizard is open. Left unattended it logs the session out mid-create; we detect
// it and click "Stay Logged In" to keep the wizard alive.
// ---------------------------------------------------------------------------
export const SIT_MODAL = {
  inactivityMarker:
    /session (inactivity|timeout|expir)|inactiv|oturum (zaman aşımı|süresi|hareketsiz|sonland)/i,
  stayLoggedIn:
    /stay logged in|keep me (logged|signed)|continue session|stay signed in|oturumu (aç[ıi]k tut|sürdür|devam)|devam et/i,
} as const;

// ---------------------------------------------------------------------------
// Zoho-backed validation errors. SIT proxies some saves through Zoho, which can
// return a transient validation banner; createStudent retries after these.
// ---------------------------------------------------------------------------
export const SIT_ERRORS = {
  validation: /validation (error|failed)|please (check|correct)|zoho|required field|geçersiz|zorunlu/i,
  duplicate:  /already exists|duplicate|zaten (var|kayıtlı|mevcut)/i,
  /**
   * SIT's "It looks like you've already submitted an application with the same
   * details" toast — the portal's own dedup guard. Treated as an IDEMPOTENT
   * SUCCESS (the application already exists), never a hard failure.
   */
  duplicateApplication:
    /already submitted|same details|looks like you'?ve already|zaten (başvur|gönder)|mükerrer başvuru/i,
  /**
   * Server-side create failure (a 503 / generic backend error surfaced as a
   * toast). Reported as a clear failure so the operator can retry.
   */
  serverError:
    /503|service unavailable|server error|internal error|something went wrong|bir (hata|sorun) olu[şs]/i,
} as const;
