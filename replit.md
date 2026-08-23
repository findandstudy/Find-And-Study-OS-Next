# EdCons OS

## Overview

EdCons OS is a production-ready SaaS for education consultancy businesses. This pnpm workspace monorepo, built with TypeScript, serves as a comprehensive operating system to streamline operations like lead management, application processing, student tracking, and financial oversight. Its purpose is to enhance efficiency, client management, and growth for staff, agents, and students in the education consultancy market. Key capabilities include dynamic pipeline management, robust role-based access control, and AI-powered document processing.

## User Preferences

The user prefers a clean, intuitive UI/UX with a focus on role-based access and clear workflows. They value dynamic content management, such as configurable pipeline stages, and robust authentication with granular permission control. AI integration should be leveraged for efficiency gains, particularly in document processing and data extraction. The system should be scalable and maintainable, built with modern web technologies.

**Communication & i18n rules (zorunlu):**
- All user-facing communication in chat: Türkçe, no emojis.
- Every new or modified user-facing string in `artifacts/edcons/src` MUST go through `useI18n()` → `t("namespace.key")`. New keys are added to all 10 locale JSONs (`en`, `tr`, `ar`, `fr`, `ru`, `fa`, `zh`, `hi`, `es`, `id`) using `.local/scripts/i18n-merge.mjs`. Hardcoded literal strings in JSX/toasts/throws are not allowed.
- Enum values, slugs, technical labels, and canonical type keys (e.g. doc-type keys, stage keys) stay untranslated — only their displayed labels are localized.

## System Architecture

The project is structured as a pnpm monorepo comprising separate packages for the API server, frontend, and shared libraries.

**Technical Stack:**
- **Monorepo:** pnpm workspaces
- **Backend:** Node.js, TypeScript, Express, PostgreSQL with Drizzle ORM, Zod.
- **Frontend:** React, Vite, TailwindCSS, shadcn/ui, Framer Motion.
- **API Codegen:** Orval (from OpenAPI spec).

**Core Architectural Decisions:**
- **Authentication:** Custom email/password authentication with session cookies and multi-role access control. Features email verification, rate limiting, and open-redirect protection. Session management includes sliding TTL and unauthorized redirect handling.
- **Role-Based Access Control (RBAC):** Granular, module-specific permissions and role-based visibility for leads and students.
- **Dynamic Pipeline Management:** Database-driven, fully configurable pipeline stages for leads, applications, and students. Supports mandatory notes, file attachments, stage progression/reversion, country-specific visibility, and finance categorization.
- **UI/UX:** Utilizes TailwindCSS and shadcn/ui for a consistent design system, featuring role-based dashboards, navigation, customizable branding, and dark mode.
- **Key Features:**
    - **Public Site:** Informational pages, DB-driven listings, multi-step public application flow with AI document extraction, and program-level document requirements driven by the selected program.
    - **User, Student, Application, Lead Management:** Comprehensive CRUD operations, AI-powered creation, bulk CSV import, stage-specific document management, and self-service student registration.
    - **Origin/Source Ownership System:** Tracks lead, student, and application origins (Direct, Agent, Sub-Agent).
    - **Finance Management:** Dynamic variant-driven finance automation for commission and service fees, with price snapshots and auto-calculated agent commissions.
    - **Agent Portal:** Dedicated portal with agent-scoped visibility, sub-agent and agent staff management, self-service account settings, and Web-to-Lead forms.
    - **Course Finder:** Program search, filtering, PDF proposal generation, and direct application creation.
    - **Communication Hub:** Internal messaging, broadcast messaging, message templates, and in-app notifications.
    - **Admin Settings Center:** Comprehensive configuration for branding, company information, SEO, email branding, document templates, and integrations.
    - **Integrations System:** Manages third-party service integrations (Communication, AI, Social Media, Custom Webhooks).
    - **Catalog Options:** Dynamic, database-driven management of dropdown options.
    - **Agent Contract Management:** Tracks contract validity with automated expiry notifications.
    - **Embeddable Widgets:** Course finder and AI-powered multi-step application forms for external websites.
    - **Omnichannel Inbox:** Integrates WhatsApp and web form messages into a centralized inbox with identity resolution and templated replies.
    - **Tasks (Görev Yönetimi):** Kanban board for task management with customizable columns, priorities, assignees, and chat-style notes. Includes role-based access and soft-delete archiving.
    - **Academic Years (Date-aware Seasons):** Each academic year has start/end dates configured in Settings → Academic Years. Backend helper `getCurrentSeason()` resolves the active season by checking which configured year contains today's date (with 30s in-process cache). All record-creation paths (applications, leads, students, finance auto-fees, agent commissions, course-finder, public-apply) tag the season using this helper instead of the calendar year. Intake periods continue to be managed under Catalog → Options.
    - **Multi-Language (i18n) System:** Supports multiple languages including RTL, URL routing, and SEO-friendly hreflang tags.
    - **Document Management System:** Document requirements are defined per **program** (Catalog → Programs → Edit Program), supports ZIP download, PDF merging, and validates program eligibility (GPA, language scores). Features re-apply without re-uploading logic and document type equivalence. Application stage transitions and the public-apply re-use flow read mandatory documents directly from the application's program.
    - **Website Module:** Full CMS with theme builder, page editor (block-based with 14 block types and global components), draft/publish/version control, SEO overrides, form builder with spam protection, and AI content assistant.
- **Edge/WAF constraint (data: URIs):** Never put a `data:...;base64,` URI larger than ~4 KB inside a JSON request body — the Replit Autoscale edge/WAF blocks it with an opaque HTML 403 *before* the request reaches Express (so there is no app-side log). Always strip the `data:image/...;base64,` prefix and send **bare base64** (e.g. signature images). Bare base64 passes even at hundreds of KB. Backend defensively re-strips the prefix and validates the decoded bytes (PNG magic + size) in `signContract.ts`.
- **Data Handling:** Consistent data structures, paginated API responses, and extensive use of soft deletes.
- **Type Safety:** Extensive use of TypeScript across the monorepo.
- **Production Deployment:** Configured for Hostinger VPS with Nginx and PM2.
- **Zero-Flash Routing:** In-memory routing to prevent browser history updates for a smoother Replit experience.
- **Resilient Error Recovery:** Lazy routes are wrapped in `ErrorBoundary` with cache-busted reload attempts and detailed error reporting.

## External Dependencies

-   **bcryptjs:** For password hashing.
-   **Anthropic Claude:** AI integration for document OCR and CSV parsing.
-   **PostgreSQL:** Primary database.
-   **Object Storage:** For uploaded files.
-   **Stripe:** Implied payment processing.
## Changelog

### 2026-05-05 — Program belge tipleri kataloğu 24 → 104 (80 yeni tip eklendi)

- Mevcut 24 kanonik program belge tipinin yanına, başvuru süreçlerinde gerekebilecek 80 yeni belge tipi eklendi: A. Akademik (10), B. Finansal (14), C. Sağlık (10), D. Vize ve Göçmenlik (15), E. Kimlik (6), F. Çalışma ve Ara Yıl (6), G. Ülkeye Özel (8), H. Konaklama ve Refakatçi (4), I. Dil ve Beyan (7).
- Hem CRM **Catalog → Programs → Edit Program → Document Requirements** ekranında seçilebiliyor (her birine label + kategori-uygun emoji ikon atandı), hem de **Excel bulk-import** sırasında ilgili snake_case kolon başlığıyla `mandatory`/`optional` değerleri kabul ediliyor.
- Senkron tutulan dört kaynak: backend whitelist `artifacts/api-server/src/routes/catalog.ts` `PROGRAM_DOC_TYPES`, frontend editor `artifacts/edcons/src/pages/admin/Catalog.tsx` `PROGRAM_DOC_TYPE_KEYS` + `DEGREE_DOC_TYPE_LABELS`, ortak UI meta `artifacts/edcons/src/lib/programDocTypes.ts` `PROGRAM_DOC_META`.
- Doc-equivalence (`lib/doc-equivalence`) yeni grupla genişletilmedi — tüm yeni tipler standalone kabul edildi (string-eşitlik fallback'i ile zorunlu/opsiyonel kontrolü çalışır). Mevcut başvurular ve önceki davranış etkilenmedi.

### 2026-05-05 — Course Finder: cascading (faceted) filter dropdowns

- Sorun: Filtreler birbirinden bağımsız çalışıyordu — kullanıcı `Country=Turkey` seçse bile City/University dropdown'ları tüm dünyadaki şehir/üniversiteleri göstermeye devam ediyordu, ve uyumsuz seçimler sessizce 0 sonuç döndürebiliyordu.
- Backend: `artifacts/api-server/src/routes/course-finder.ts` — yeni `buildProgramFacetConditions(params, excludeKey?)` helper. `/course-finder/filters` route'u artık sorgu parametrelerini alıyor; her facet (country/city/universityType/universityId/level/language/field/feeRange) için diğer tüm seçili filtreleri uygular ama kendi facet'ini hariç tutar (kullanıcı seçimini değiştirebilsin diye). Promise.all ile 8 paralel sorgu + try/catch ile 500 logging.
- Backend (widget): `artifacts/api-server/src/routes/embed.ts` `/public/embed/:slug/filters` aynı cascading mantığı + admin'in `presetFilters`'ı her zaman uygulanır (ziyaretçi override edemez, kendi facet'inde bile).
- Frontend (staff): `artifacts/edcons/src/pages/staff/CourseFinder.tsx` — `filterOptions` useQuery artık queryKey'inde mevcut filter state'ini taşıyor ve `staleTime: 30s` + `placeholderData: keepPrevious`. Yeni useEffect, options değiştiğinde geçersiz kalan seçimleri (ör. Country=Germany seçince stale City=Istanbul) otomatik temizliyor.
- Frontend (public): `artifacts/edcons/src/pages/public/Programs.tsx` — `useEffect(()=>fetch('/filters'), [])` empty-deps yerine `filterParams` useMemo'ya bağlı; aynı stale-pruning useEffect'i.
- Widget JS (`generateWidgetHTML`): `loadFilters()` her change'te paralel olarak `loadPrograms()` ile birlikte çağrılır; `pruneStaleSelections()` `userFilters`'tan geçersiz değerleri siler. `init()` artık tek `/config` çağrısı yapıp `loadPrograms`'a delegate ediyor (filters orada zaten yükleniyor).

### 2026-05-05 — Bulk-import: body limit + Postgres bind-parameter chunking + error logging

- **Body limit (HTTP 413 fix):** `artifacts/api-server/src/app.ts` — `express.json` ve `express.urlencoded` limit 10mb → 50mb. 7000+ programlı Excel (54 kolon, ~16 MB JSON serialize) artık reddedilmiyor. Endpoint'ler zaten requireAuth + MANAGER_ROLES ile korunuyor.
- **Chunking (HTTP 500 fix):** `artifacts/api-server/src/routes/catalog.ts` — `/programs/bulk` rotası tek `INSERT...VALUES` ile 7000 satır × ~22 kolon = 154k bind parametre üretiyordu, Postgres 16-bit (32767) limitini patlatıyordu. Hem `programsTable` insert (`INSERT_CHUNK = 500`), hem `programDocumentRequirementsTable` delete (`ID_CHUNK = 5000`) ve insert (`DOC_CHUNK = 1000`) artık chunk halinde yapılıyor.
- **Error logging:** Aynı route'a try/catch sarıldı; `console.error` ile detaylı log + cevap body'sinde `{error, code, detail, hint}` döndürülüyor (önceden generic 500, sebep görünmezdi).

### 2026-05-05 — Create Application dialog'ları artık program-spesifik belge gereksinimlerini gösteriyor

- Sorun: Catalog → Programs → Edit Program ekranında (veya bulk-import ile) belirlenen 23+ zorunlu belge, "Create Application" akışında görünmüyordu — dialog hâlâ degree-bazlı hardcoded 5'li listeyi (HS Diploma/HS Transcript/Passport/Photograph/Language Proof) kullanıyordu.
- Yeni ortak yardımcı: `artifacts/edcons/src/lib/programDocTypes.ts` — `PROGRAM_DOC_META` (24 kanonik doc-type için label/icon/accept) + `useProgramDocRequirements(programId)` React Query hook + `resolveDocMeta()` fallback'i.
- `staff/CourseFinder.tsx` Create Application dialog'u: `LEVEL_DOCS[degreeToLevel(...)]` yerine programın gerçek gereksinim listesini fetch ediyor; programa hiç requirement tanımlanmamışsa eski LEVEL_DOCS fallback'i korundu (boş liste UX'inden kaçınmak için).
- `public/Programs.tsx` ApplyDialog'u: aynı şekilde `getDocTypesForDegree` artık fallback; `DocType.label` opsiyonel alanı eklendi ve DropZone'lar `docType.label ?? t(docType.labelKey)` ile snake_case anahtarlarda i18n eksikliğini telafi ediyor. `DocKey` artık string.
- BulkImportModal hata mesajı: 401/403/CSRF hataları ayrıştırılıp net mesajlar (`Your session has expired…`) gösteriliyor.

### 2026-05-05 — Task #97: Degree-bazlı belge gereksinimleri kaldırıldı

- Belge gereksinimleri artık tamamen **program seviyesinde** yönetiliyor (Catalog → Programs → Edit Program). Catalog → Options → Degree sekmesindeki "Documents" düğmesi ve `DegreeDocumentsDialog` kaldırıldı.
- Frontend: `StudentDocChecklist` yalnızca programdan okuyor; program bağlamı yokken net "program seçin" boş durumu gösteriyor. Eski `_legacyNormalizeLevel` ve degree-bazlı fallback sorgusu silindi. `staff/StudentDetail` sayfasından degree-bazlı "Required Documents" rozet bloğu kaldırıldı; aynı bilgi her başvurunun detay sayfasında program-bazlı gösteriliyor.
- Backend: `applications.ts` (documents_collected aşama geçişi) ve `public-apply.ts` (yeniden kullanılan belge filtresi) artık `programDocumentRequirementsTable`'dan başvurunun `programId`'siyle okuyor. `routes/documentRequirements.ts`, `seedDocumentRequirements`, `backfillProgramDocumentRequirements` fonksiyonları ve startup'taki çağrıları kaldırıldı; `system_flags.program_doc_requirements_backfill_v1` kilidi temizlendi.
- DB: `document_requirements` tablosu DROP edildi; Drizzle şemasından `documentRequirements.ts` silindi ve `lib/db/src/schema/index.ts` export'u kaldırıldı.
- Docs: `API_DOCS.md` "Document Requirements" (eski bölüm 21) bölümü silindi ve sonraki bölümler 22→27 olarak yeniden numaralandırıldı.
