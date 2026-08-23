/**
 * scripts/report-topkapi-missing-docs.ts
 *
 * MUTABAKAT RAPORU (salt-okunur — hiçbir şey DEĞİŞTİRMEZ, otomatik geri alma YOK):
 * Topkapı üzerinden "submitted" statüsüne geçmiş ve başvurusu awaiting_offer
 * aşamasında olan kayıtları listeler ve belgelerin gerçekten yüklenip
 * yüklenmediğine dair kanıtı değerlendirir.
 *
 * Kanıt kaynağı: portal_submissions.result_json.result.uploadedSlots
 *  - Yeni koddan sonra oluşan kayıtlarda adapter, portal formuna GERÇEKTEN
 *    eklenip doğrulanan slotları buraya yazar.
 *  - Eski kayıtlarda bu alan YOKTUR → "ŞÜPHELİ (kanıt yok)" olarak işaretlenir;
 *    bu kayıtlar üniversite portalından elle kontrol edilmelidir.
 *
 * Ek bağlam olarak öğrencinin CRM'deki içerik taşıyan belge slotları da
 * (photo/passport/transcript/diploma) gösterilir.
 *
 * Kullanım (VPS/prod dahil, DATABASE_URL ortamından):
 *   pnpm --filter @workspace/api-server exec tsx scripts/report-topkapi-missing-docs.ts
 */

import {
  db,
  portalSubmissionsTable,
  applicationsTable,
  studentsTable,
  documentsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

const REQUIRED_SLOTS = ["photo", "passport", "transcript", "diploma"] as const;
type Slot = (typeof REQUIRED_SLOTS)[number];

// Belge tipi → slot eşlemesi (worker/runner profil kurucularıyla aynı mantık,
// script bağımsız kalsın diye burada sadeleştirilmiş kopya).
function mapDocType(raw: string): Slot | null {
  const t = raw.toLowerCase();
  if (/(photo|foto|vesikal)/.test(t)) return "photo";
  if (/(passport|pasaport)/.test(t)) return "passport";
  if (/(transcript|transkript|not d)/.test(t)) return "transcript";
  if (/(diploma|diplom|mezuniyet)/.test(t)) return "diploma";
  return null;
}

async function main(): Promise<void> {
  const subs = await db
    .select({
      id:            portalSubmissionsTable.id,
      applicationId: portalSubmissionsTable.applicationId,
      studentId:     portalSubmissionsTable.studentId,
      universityKey: portalSubmissionsTable.universityKey,
      externalRef:   portalSubmissionsTable.externalRef,
      resultJson:    portalSubmissionsTable.resultJson,
      createdAt:     portalSubmissionsTable.createdAt,
      stage:         applicationsTable.stage,
      studentName:   sql<string>`coalesce(${studentsTable.firstName} || ' ' || ${studentsTable.lastName}, '(silinmiş öğrenci)')`,
    })
    .from(portalSubmissionsTable)
    .innerJoin(applicationsTable, eq(applicationsTable.id, portalSubmissionsTable.applicationId))
    .leftJoin(studentsTable, eq(studentsTable.id, portalSubmissionsTable.studentId))
    .where(
      and(
        eq(portalSubmissionsTable.status, "submitted"),
        eq(portalSubmissionsTable.mode, "real"),
        sql`${portalSubmissionsTable.universityKey} ilike '%topkapi%'`,
        eq(applicationsTable.stage, "awaiting_offer"),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    )
    .orderBy(desc(portalSubmissionsTable.createdAt));

  if (subs.length === 0) {
    console.log("Topkapı: submitted + awaiting_offer kayıt bulunamadı.");
    return;
  }

  // Öğrencilerin içerik taşıyan CRM belgelerini topluca çek
  const studentIds = [...new Set(subs.map((s) => s.studentId).filter((v): v is number => v != null))];
  const docRows = studentIds.length
    ? await db
        .select({
          studentId: documentsTable.studentId,
          type:      documentsTable.type,
          fileKey:   documentsTable.fileKey,
          fileUrl:   documentsTable.fileUrl,
          hasData:   sql<boolean>`(${documentsTable.fileData} is not null and ${documentsTable.fileData} <> '')`,
        })
        .from(documentsTable)
        .where(and(inArray(documentsTable.studentId, studentIds), isNull(documentsTable.deletedAt)))
    : [];

  const crmSlots = new Map<number, Set<Slot>>();
  for (const d of docRows) {
    if (!d.studentId || !d.type) continue;
    if (!d.fileKey && !d.fileUrl && !d.hasData) continue; // boş stub
    const slot = mapDocType(d.type);
    if (!slot) continue;
    if (!crmSlots.has(d.studentId)) crmSlots.set(d.studentId, new Set());
    crmSlots.get(d.studentId)!.add(slot);
  }

  let suspect = 0;
  console.log(`Topkapı submitted + awaiting_offer: ${subs.length} kayıt\n`);
  for (const s of subs) {
    const rj = s.resultJson as { result?: { uploadedSlots?: unknown } } | null;
    const uploaded = Array.isArray(rj?.result?.uploadedSlots)
      ? (rj!.result!.uploadedSlots as string[])
      : null;
    const missing = uploaded ? REQUIRED_SLOTS.filter((sl) => !uploaded.includes(sl)) : null;
    const crm = s.studentId ? [...(crmSlots.get(s.studentId) ?? [])] : [];
    const crmMissing = REQUIRED_SLOTS.filter((sl) => !crm.includes(sl));

    let verdict: string;
    if (uploaded === null) {
      verdict = "ŞÜPHELİ — yükleme kanıtı yok (eski kayıt), portalda elle kontrol edin";
      suspect++;
    } else if (missing && missing.length > 0) {
      verdict = `EKSİK — yüklenmeyen slotlar: ${missing.join(", ")}`;
      suspect++;
    } else {
      verdict = "OK — 4/4 slot doğrulanmış yüklendi";
    }

    console.log(
      `#${s.id} | app ${s.applicationId} | ${s.studentName}` +
      ` | ref=${s.externalRef ?? "-"} | ${s.createdAt?.toISOString?.() ?? s.createdAt}\n` +
      `    Kanıt: ${uploaded ? `[${uploaded.join(", ")}]` : "yok"} | CRM'de var: [${crm.join(", ") || "hiçbiri"}]` +
      (crmMissing.length ? ` | CRM'de eksik: [${crmMissing.join(", ")}]` : "") +
      `\n    Sonuç: ${verdict}\n`,
    );
  }
  console.log(`Toplam: ${subs.length} kayıt, ${suspect} tanesi şüpheli/eksik.`);
  console.log("NOT: Bu rapor SADECE listeler — hiçbir statü/aşama otomatik geri alınmaz.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Rapor hatası:", err);
    process.exit(1);
  });
