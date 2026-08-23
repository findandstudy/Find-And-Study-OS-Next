import { Router, type IRouter } from "express";
import {
  db,
  universityContractsTable,
  universitiesTable,
  destinationsTable,
  usersTable,
  getUniversityContractStatus,
  type UniversityContractStatus,
} from "@workspace/db";
import { and, eq, ilike, isNull, isNotNull, desc, lt, lte, gt, gte, or, type SQL } from "drizzle-orm";
import { requireAuth, requirePermission } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";

const router: IRouter = Router();

const ALLOWED_STATUSES: UniversityContractStatus[] = ["active", "expiring_soon", "expired", "no_dates"];

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

class InvalidInputError extends Error {}

function parseDateStrict(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = parseDate(value);
  if (d === null) throw new InvalidInputError(`Invalid ${field}`);
  return d;
}

const ALLOWED_CONTRACT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // legacy .doc — accepted as docx-equivalent
]);
const ALLOWED_CONTRACT_EXTS = /\.(pdf|docx|doc)$/i;

function validateContractFile(mime: unknown, name: unknown): void {
  const m = typeof mime === "string" ? mime.toLowerCase() : "";
  const n = typeof name === "string" ? name : "";
  if (!ALLOWED_CONTRACT_MIMES.has(m) && !ALLOWED_CONTRACT_EXTS.test(n)) {
    throw new InvalidInputError("Only PDF or DOCX files are allowed for university contracts");
  }
}

function parseAssignedUserIds(input: unknown): number[] | undefined {
  if (input === undefined) return undefined;
  if (input === null) return [];
  if (!Array.isArray(input)) throw new InvalidInputError("assignedUserIds must be an array of user IDs");
  const out: number[] = [];
  for (const v of input) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isInteger(n) || n <= 0) throw new InvalidInputError("assignedUserIds entries must be positive integers");
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function sanitizeUploadedKey(input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") throw new InvalidInputError("Invalid fileObjectKey");
  let key = input.trim();
  if (key.startsWith("https://")) {
    // Defer to ObjectStorageService normalization synchronously not possible here;
    // accept only already-normalized /objects/uploads/... keys to prevent binding arbitrary
    // private object keys. Callers must send the objectPath returned by /api/storage/uploads/request-url.
    throw new InvalidInputError("fileObjectKey must be a normalized /objects/uploads/... path");
  }
  // Object storage returns canonical paths like
  //   /objects/uploads/<uuid>
  //   /objects/<subdir>/<uuid>-<filename>
  // so allow nested safe path segments under /objects/.
  if (!/^\/objects\/[A-Za-z0-9_./-]+$/.test(key)) {
    throw new InvalidInputError("fileObjectKey must be a /objects/... path");
  }
  if (key.includes("..") || key.includes("//")) {
    throw new InvalidInputError("fileObjectKey contains invalid path segments");
  }
  return key;
}

function enrichRow(row: any): any {
  return {
    ...row,
    status: getUniversityContractStatus(row.expiryDate),
  };
}

router.get("/university-contracts", requireAuth, requirePermission("university_contracts.view"), async (req, res): Promise<void> => {
  try {
    const { country, year, universityId, search, status } = req.query as Record<string, string>;
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "25", 10)));
    const offset = (page - 1) * pageSize;

    const filters: SQL<unknown>[] = [isNull(universityContractsTable.deletedAt)];
    if (country) filters.push(eq(universityContractsTable.country, country));
    if (year) {
      const y = parseInt(year, 10);
      if (!isNaN(y)) filters.push(eq(universityContractsTable.year, y));
    }
    if (universityId) {
      const u = parseInt(universityId, 10);
      if (!isNaN(u)) filters.push(eq(universityContractsTable.universityId, u));
    }

    // Status boundaries are derived from getUniversityContractStatus:
    //   expired       : expiryDate <  now
    //   expiring_soon : now <= expiryDate <= now+30d
    //   active        : expiryDate >  now+30d
    //   no_dates      : expiryDate IS NULL
    if (status && ALLOWED_STATUSES.includes(status as UniversityContractStatus)) {
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      if (status === "expired") filters.push(lt(universityContractsTable.expiryDate, now));
      else if (status === "expiring_soon") {
        filters.push(gte(universityContractsTable.expiryDate, now));
        filters.push(lte(universityContractsTable.expiryDate, in30));
      } else if (status === "active") {
        filters.push(gt(universityContractsTable.expiryDate, in30));
      } else if (status === "no_dates") filters.push(isNull(universityContractsTable.expiryDate));
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      const orExpr = or(
        ilike(universitiesTable.name, term),
        ilike(universityContractsTable.country, term),
        ilike(universityContractsTable.fileName, term),
      );
      if (orExpr) filters.push(orExpr);
    }

    const where = and(...filters);
    const rows = await db.select({
      id: universityContractsTable.id,
      universityId: universityContractsTable.universityId,
      destinationId: universityContractsTable.destinationId,
      country: universityContractsTable.country,
      year: universityContractsTable.year,
      effectiveDate: universityContractsTable.effectiveDate,
      expiryDate: universityContractsTable.expiryDate,
      fileObjectKey: universityContractsTable.fileObjectKey,
      fileName: universityContractsTable.fileName,
      fileMime: universityContractsTable.fileMime,
      fileSize: universityContractsTable.fileSize,
      notes: universityContractsTable.notes,
      uploadedByUserId: universityContractsTable.uploadedByUserId,
      createdAt: universityContractsTable.createdAt,
      updatedAt: universityContractsTable.updatedAt,
      assignedUserIds: universityContractsTable.assignedUserIds,
      universityName: universitiesTable.name,
      universityCity: universitiesTable.city,
      universityLogoUrl: universitiesTable.logoUrl,
      destinationName: destinationsTable.name,
      destinationCountry: destinationsTable.country,
      destinationFlagEmoji: destinationsTable.flagEmoji,
    })
      .from(universityContractsTable)
      .leftJoin(universitiesTable, eq(universitiesTable.id, universityContractsTable.universityId))
      .leftJoin(destinationsTable, eq(destinationsTable.id, universityContractsTable.destinationId))
      .where(where)
      .orderBy(desc(universityContractsTable.createdAt))
      .limit(pageSize + 1)
      .offset(offset);

    const hasMore = rows.length > pageSize;
    const data = rows.slice(0, pageSize).map(enrichRow);
    res.json({ data, page, pageSize, hasMore });
  } catch (err) {
    console.error("[university-contracts] list:", err);
    res.status(500).json({ error: "Failed to list university contracts" });
  }
});

router.get("/university-contracts/:id", requireAuth, requirePermission("university_contracts.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(universityContractsTable)
      .where(and(eq(universityContractsTable.id, id), isNull(universityContractsTable.deletedAt)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    const [uni] = row.universityId ? await db.select({
      id: universitiesTable.id,
      name: universitiesTable.name,
      country: universitiesTable.country,
      city: universitiesTable.city,
    }).from(universitiesTable).where(eq(universitiesTable.id, row.universityId)) : [null];

    let uploader: { id: number; firstName: string | null; lastName: string | null; email: string | null } | null = null;
    if (row.uploadedByUserId) {
      const [u] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable).where(eq(usersTable.id, row.uploadedByUserId));
      uploader = u || null;
    }

    res.json({ data: { ...enrichRow(row), university: uni, uploader } });
  } catch (err) {
    console.error("[university-contracts] get:", err);
    res.status(500).json({ error: "Failed to load contract" });
  }
});

router.post("/university-contracts", requireAuth, requirePermission("university_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const body = req.body || {};
    const universityId = parseInt(String(body.universityId), 10);
    if (!universityId) { res.status(400).json({ error: "universityId is required" }); return; }
    const [uni] = await db.select().from(universitiesTable).where(eq(universitiesTable.id, universityId));
    if (!uni) { res.status(404).json({ error: "University not found" }); return; }

    let destinationId: number | null = null;
    if (body.destinationId) {
      const dId = parseInt(String(body.destinationId), 10);
      if (dId) destinationId = dId;
    }
    if (!destinationId && uni.country) {
      const [dest] = await db.select({ id: destinationsTable.id }).from(destinationsTable)
        .where(eq(destinationsTable.country, uni.country));
      if (dest) destinationId = dest.id;
    }

    const effectiveDate = parseDateStrict(body.effectiveDate, "effectiveDate");
    const expiryDate = parseDateStrict(body.expiryDate, "expiryDate");
    const year = body.year ? parseInt(String(body.year), 10) : (effectiveDate ? effectiveDate.getFullYear() : null);

    const fileObjectKey = sanitizeUploadedKey(body.fileObjectKey);
    if (fileObjectKey) validateContractFile(body.fileMime, body.fileName);

    const assignedUserIds = parseAssignedUserIds(body.assignedUserIds) ?? [];

    const [row] = await db.insert(universityContractsTable).values({
      universityId,
      destinationId,
      country: uni.country,
      year: Number.isInteger(year as number) ? (year as number) : null,
      effectiveDate,
      expiryDate,
      fileObjectKey,
      fileName: body.fileName ? String(body.fileName).slice(0, 500) : null,
      fileMime: body.fileMime ? String(body.fileMime).slice(0, 200) : null,
      fileSize: Number.isInteger(body.fileSize) ? body.fileSize : null,
      notes: body.notes ? String(body.notes).slice(0, 5000) : null,
      uploadedByUserId: (req as any).user?.id ?? null,
      assignedUserIds,
    }).returning();

    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "university_contract.created",
      resource: "university_contract",
      resourceId: row.id,
      changes: { universityId, country: uni.country, expiryDate: expiryDate?.toISOString() },
      ipAddress: req.ip,
    });

    res.status(201).json({ data: enrichRow(row) });
  } catch (err) {
    if (err instanceof InvalidInputError) { res.status(400).json({ error: err.message }); return; }
    console.error("[university-contracts] create:", err);
    res.status(500).json({ error: "Failed to create contract" });
  }
});

router.patch("/university-contracts/:id", requireAuth, requirePermission("university_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [existing] = await db.select().from(universityContractsTable)
      .where(and(eq(universityContractsTable.id, id), isNull(universityContractsTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const body = req.body || {};
    const updates: Record<string, unknown> = {};
    let resetWarnings = false;

    if (body.universityId !== undefined) {
      const newUniId = parseInt(String(body.universityId), 10);
      if (!newUniId) { res.status(400).json({ error: "Invalid universityId" }); return; }
      const [uni] = await db.select().from(universitiesTable).where(eq(universitiesTable.id, newUniId));
      if (!uni) { res.status(404).json({ error: "University not found" }); return; }
      updates.universityId = newUniId;
      updates.country = uni.country;
      const [dest] = await db.select({ id: destinationsTable.id }).from(destinationsTable)
        .where(eq(destinationsTable.country, uni.country));
      updates.destinationId = dest?.id ?? null;
    }
    if (body.destinationId !== undefined) {
      const dId = body.destinationId === null ? null : parseInt(String(body.destinationId), 10) || null;
      updates.destinationId = dId;
    }
    if (body.year !== undefined) {
      const y = body.year === null ? null : parseInt(String(body.year), 10);
      updates.year = y && !isNaN(y) ? y : null;
    }
    if (body.effectiveDate !== undefined) updates.effectiveDate = parseDateStrict(body.effectiveDate, "effectiveDate");
    if (body.expiryDate !== undefined) {
      const newExpiry = parseDateStrict(body.expiryDate, "expiryDate");
      updates.expiryDate = newExpiry;
      const oldExpiryMs = existing.expiryDate ? new Date(existing.expiryDate).getTime() : null;
      const newExpiryMs = newExpiry ? newExpiry.getTime() : null;
      if (oldExpiryMs !== newExpiryMs) resetWarnings = true;
    }
    if (body.notes !== undefined) updates.notes = body.notes ? String(body.notes).slice(0, 5000) : null;

    if (body.fileObjectKey !== undefined) {
      const newKey = sanitizeUploadedKey(body.fileObjectKey);
      if (newKey) validateContractFile(body.fileMime, body.fileName);
      updates.fileObjectKey = newKey;
      updates.fileName = body.fileName ? String(body.fileName).slice(0, 500) : null;
      updates.fileMime = body.fileMime ? String(body.fileMime).slice(0, 200) : null;
      updates.fileSize = Number.isInteger(body.fileSize) ? body.fileSize : null;
    }

    const assignedUserIds = parseAssignedUserIds(body.assignedUserIds);
    if (assignedUserIds !== undefined) updates.assignedUserIds = assignedUserIds;

    if (resetWarnings) {
      updates.lastWarning30SentAt = null;
      updates.lastWarning14SentAt = null;
      updates.lastWarning7SentAt = null;
      updates.lastWarning1SentAt = null;
      updates.expiryNoticeSentAt = null;
    }

    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const [row] = await db.update(universityContractsTable).set(updates)
      .where(eq(universityContractsTable.id, id)).returning();

    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "university_contract.updated",
      resource: "university_contract",
      resourceId: id,
      changes: updates as object,
      ipAddress: req.ip,
    });

    res.json({ data: enrichRow(row) });
  } catch (err) {
    if (err instanceof InvalidInputError) { res.status(400).json({ error: err.message }); return; }
    console.error("[university-contracts] update:", err);
    res.status(500).json({ error: "Failed to update contract" });
  }
});

router.delete("/university-contracts/:id", requireAuth, requirePermission("university_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.update(universityContractsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(universityContractsTable.id, id), isNull(universityContractsTable.deletedAt)))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "university_contract.deleted",
      resource: "university_contract",
      resourceId: id,
      ipAddress: req.ip,
    });

    res.sendStatus(204);
  } catch (err) {
    console.error("[university-contracts] delete:", err);
    res.status(500).json({ error: "Failed to delete contract" });
  }
});

router.get("/university-contracts/:id/file", requireAuth, requirePermission("university_contracts.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(universityContractsTable)
      .where(and(eq(universityContractsTable.id, id), isNull(universityContractsTable.deletedAt)));
    if (!row || !row.fileObjectKey) { res.status(404).json({ error: "File not found" }); return; }

    const { ObjectStorageService } = await import("../lib/objectStorage");
    const svc = new ObjectStorageService();
    const file = await svc.getObjectEntityFile(row.fileObjectKey);
    const safeName = (row.fileName || `contract-${id}`).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    await svc.streamObjectToResponse(req, res, file, {
      contentType: row.fileMime || undefined,
      cacheControl: "private, no-store",
    });
  } catch (err) {
    console.error("[university-contracts] download:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download file" });
  }
});

export default router;
