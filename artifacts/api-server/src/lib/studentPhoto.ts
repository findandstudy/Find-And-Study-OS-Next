import { db, studentsTable, documentsTable } from "@workspace/db";
import { and, eq, or, isNull, desc, sql } from "drizzle-orm";

/**
 * Read-side source of truth for whether the latest photo document is servable.
 *
 * `students.has_photo` is maintained as a cache for new writes, but historical
 * rows can predate that synchronization. List endpoints use this expression so
 * their avatars agree with GET /api/students/:id/photo without mutating data.
 */
export function studentHasServablePhotoSql() {
  return sql<boolean>`COALESCE((
    SELECT (
      (NULLIF(${documentsTable.fileKey}, '') IS NOT NULL)
      OR (NULLIF(${documentsTable.fileData}, '') IS NOT NULL)
      OR (${documentsTable.fileUrl} ~* '^https?://')
    )
    FROM ${documentsTable}
    WHERE ${documentsTable.studentId} = ${studentsTable.id}
      AND ${documentsTable.type} IN ('photo', 'photograph')
      AND ${documentsTable.deletedAt} IS NULL
    ORDER BY ${documentsTable.createdAt} DESC, ${documentsTable.id} DESC
    LIMIT 1
  ), false)`;
}

/**
 * Single source of truth for the denormalized students.has_photo + photo_url
 * columns. Recomputes them to mirror EXACTLY what GET /api/students/:id/photo
 * would do — that endpoint is what every avatar surface ultimately fetches.
 *
 * The endpoint takes the LATEST non-deleted photo/photograph document and serves
 * it only when it has a fileKey (object storage), fileData (base64 in DB), or an
 * http(s) fileUrl (302 redirect; a data:/file: fileUrl is rejected with 422 by
 * the SSRF guard). So has_photo must be true iff that same latest doc is
 * servable — otherwise the flag drifts and the avatar either hides a real photo
 * (the bug this fixes) or shows a broken image for an unservable doc.
 *
 * Call after ANY insert or soft-delete of a photo/photograph document. Idempotent
 * and error-safe — failures are logged but never thrown so they can't break the
 * surrounding upload/delete flow.
 */
export async function recomputeStudentPhoto(studentId: number | null | undefined): Promise<void> {
  if (!studentId) return;
  try {
    const [photoDoc] = await db
      .select({
        fileKey: documentsTable.fileKey,
        fileData: documentsTable.fileData,
        fileUrl: documentsTable.fileUrl,
      })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.studentId, studentId),
        or(eq(documentsTable.type, "photo"), eq(documentsTable.type, "photograph")),
        isNull(documentsTable.deletedAt),
      ))
      .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id))
      .limit(1);
    // Match the endpoint's servability rule precisely (JS-falsy: "" counts as absent).
    const servable = !!photoDoc && (
      !!photoDoc.fileKey ||
      !!photoDoc.fileData ||
      (!!photoDoc.fileUrl && /^https?:\/\//i.test(photoDoc.fileUrl))
    );
    await db
      .update(studentsTable)
      .set({ hasPhoto: servable, photoUrl: servable ? `/api/students/${studentId}/photo` : null })
      .where(eq(studentsTable.id, studentId));
  } catch (err) {
    console.error(`[studentPhoto] recompute for student #${studentId} failed:`, err);
  }
}
