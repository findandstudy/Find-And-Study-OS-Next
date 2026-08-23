import { Router, type IRouter } from "express";
import {
  db,
  companyContractsTable,
  usersTable,
  getCompanyContractStatus,
  type CompanyContractStatus,
} from "@workspace/db";
import { and, eq, ilike, isNull, desc, lt, lte, gt, gte, or, type SQL } from "drizzle-orm";
import { requireAuth, requirePermission } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";

const router: IRouter = Router();

const ALLOWED_STATUSES: CompanyContractStatus[] = ["active", "expiring_soon", "expired", "no_dates"];

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
    throw new InvalidInputError("Only PDF or DOCX files are allowed for company contracts");
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
  const key = input.trim();
  if (key.startsWith("https://")) {
    // Accept only already-normalized /objects/uploads/... keys to prevent binding
    // arbitrary private object keys. Callers must send the objectPath returned by
    // /api/storage/uploads/request-url.
    throw new InvalidInputError("fileObjectKey must be a normalized /objects/uploads/... path");
  }
  if (!/^\/objects\/[A-Za-z0-9_./-]+$/.test(key)) {
    throw new InvalidInputError("fileObjectKey must be a /objects/... path");
  }
  if (key.includes("..") || key.includes("//")) {
    throw new InvalidInputError("fileObjectKey contains invalid path segments");
  }
  return key;
}

function normalizeCompanyName(input: unknown): string {
  if (typeof input !== "string") throw new InvalidInputError("companyName is required");
  const name = input.trim();
  if (!name) throw new InvalidInputError("companyName is required");
  return name.slice(0, 300);
}

function normalizeCountry(input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") throw new InvalidInputError("Invalid country");
  const c = input.trim();
  return c ? c.slice(0, 200) : null;
}

function enrichRow(row: any): any {
  return {
    ...row,
    status: getCompanyContractStatus(row.expiryDate),
  };
}

router.get("/company-contracts", requireAuth, requirePermission("company_contracts.view"), async (req, res): Promise<void> => {
  try {
    const { country, year, search, status, company } = req.query as Record<string, string>;
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "25", 10)));
    const offset = (page - 1) * pageSize;

    const filters: SQL<unknown>[] = [isNull(companyContractsTable.deletedAt)];
    if (country) filters.push(eq(companyContractsTable.country, country));
    if (company && company.trim()) filters.push(eq(companyContractsTable.companyName, company.trim()));
    if (year) {
      const y = parseInt(year, 10);
      if (!isNaN(y)) filters.push(eq(companyContractsTable.year, y));
    }

    // Date-range filters. Each range is inclusive on both ends; the end date is
    // pushed to end-of-day so a same-day "to" bound still matches. Invalid dates
    // are ignored (best-effort filter, never 400s the list).
    const effectiveFrom = parseDate(req.query.effectiveFrom);
    const effectiveTo = parseDate(req.query.effectiveTo);
    const expiryFrom = parseDate(req.query.expiryFrom);
    const expiryTo = parseDate(req.query.expiryTo);
    const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    if (effectiveFrom) filters.push(gte(companyContractsTable.effectiveDate, effectiveFrom));
    if (effectiveTo) filters.push(lte(companyContractsTable.effectiveDate, endOfDay(effectiveTo)));
    if (expiryFrom) filters.push(gte(companyContractsTable.expiryDate, expiryFrom));
    if (expiryTo) filters.push(lte(companyContractsTable.expiryDate, endOfDay(expiryTo)));

    // Status boundaries are derived from getCompanyContractStatus:
    //   expired       : expiryDate <  now
    //   expiring_soon : now <= expiryDate <= now+30d
    //   active        : expiryDate >  now+30d
    //   no_dates      : expiryDate IS NULL
    if (status && ALLOWED_STATUSES.includes(status as CompanyContractStatus)) {
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      if (status === "expired") filters.push(lt(companyContractsTable.expiryDate, now));
      else if (status === "expiring_soon") {
        filters.push(gte(companyContractsTable.expiryDate, now));
        filters.push(lte(companyContractsTable.expiryDate, in30));
      } else if (status === "active") {
        filters.push(gt(companyContractsTable.expiryDate, in30));
      } else if (status === "no_dates") filters.push(isNull(companyContractsTable.expiryDate));
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      const orExpr = or(
        ilike(companyContractsTable.companyName, term),
        ilike(companyContractsTable.country, term),
        ilike(companyContractsTable.fileName, term),
      );
      if (orExpr) filters.push(orExpr);
    }

    const where = and(...filters);
    const rows = await db.select()
      .from(companyContractsTable)
      .where(where)
      .orderBy(desc(companyContractsTable.createdAt))
      .limit(pageSize + 1)
      .offset(offset);

    const hasMore = rows.length > pageSize;
    const data = rows.slice(0, pageSize).map(enrichRow);
    res.json({ data, page, pageSize, hasMore });
  } catch (err) {
    console.error("[company-contracts] list:", err);
    res.status(500).json({ error: "Failed to list company contracts" });
  }
});

// Distinct company names for the list's company filter dropdown. Registered
// BEFORE /:id so "companies" is not captured as an :id param.
router.get("/company-contracts/companies", requireAuth, requirePermission("company_contracts.view"), async (_req, res): Promise<void> => {
  try {
    const rows = await db.selectDistinct({ companyName: companyContractsTable.companyName })
      .from(companyContractsTable)
      .where(isNull(companyContractsTable.deletedAt))
      .orderBy(companyContractsTable.companyName);
    res.json({ data: rows.map((r) => r.companyName).filter(Boolean) });
  } catch (err) {
    console.error("[company-contracts] companies:", err);
    res.status(500).json({ error: "Failed to list companies" });
  }
});

router.get("/company-contracts/:id", requireAuth, requirePermission("company_contracts.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(companyContractsTable)
      .where(and(eq(companyContractsTable.id, id), isNull(companyContractsTable.deletedAt)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    let uploader: { id: number; firstName: string | null; lastName: string | null; email: string | null } | null = null;
    if (row.uploadedByUserId) {
      const [u] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable).where(eq(usersTable.id, row.uploadedByUserId));
      uploader = u || null;
    }

    res.json({ data: { ...enrichRow(row), uploader } });
  } catch (err) {
    console.error("[company-contracts] get:", err);
    res.status(500).json({ error: "Failed to load contract" });
  }
});

router.post("/company-contracts", requireAuth, requirePermission("company_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const body = req.body || {};
    const companyName = normalizeCompanyName(body.companyName);
    const country = normalizeCountry(body.country);

    const effectiveDate = parseDateStrict(body.effectiveDate, "effectiveDate");
    const expiryDate = parseDateStrict(body.expiryDate, "expiryDate");
    const year = body.year ? parseInt(String(body.year), 10) : (effectiveDate ? effectiveDate.getFullYear() : null);

    const fileObjectKey = sanitizeUploadedKey(body.fileObjectKey);
    if (fileObjectKey) validateContractFile(body.fileMime, body.fileName);

    const assignedUserIds = parseAssignedUserIds(body.assignedUserIds) ?? [];

    const [row] = await db.insert(companyContractsTable).values({
      companyName,
      country,
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
      action: "company_contract.created",
      resource: "company_contract",
      resourceId: row.id,
      changes: { companyName, country, expiryDate: expiryDate?.toISOString() },
      ipAddress: req.ip,
    });

    res.status(201).json({ data: enrichRow(row) });
  } catch (err) {
    if (err instanceof InvalidInputError) { res.status(400).json({ error: err.message }); return; }
    console.error("[company-contracts] create:", err);
    res.status(500).json({ error: "Failed to create contract" });
  }
});

router.patch("/company-contracts/:id", requireAuth, requirePermission("company_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [existing] = await db.select().from(companyContractsTable)
      .where(and(eq(companyContractsTable.id, id), isNull(companyContractsTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const body = req.body || {};
    const updates: Record<string, unknown> = {};
    let resetWarnings = false;

    if (body.companyName !== undefined) updates.companyName = normalizeCompanyName(body.companyName);
    if (body.country !== undefined) updates.country = normalizeCountry(body.country);
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

    const [row] = await db.update(companyContractsTable).set(updates)
      .where(eq(companyContractsTable.id, id)).returning();

    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "company_contract.updated",
      resource: "company_contract",
      resourceId: id,
      changes: updates as object,
      ipAddress: req.ip,
    });

    res.json({ data: enrichRow(row) });
  } catch (err) {
    if (err instanceof InvalidInputError) { res.status(400).json({ error: err.message }); return; }
    console.error("[company-contracts] update:", err);
    res.status(500).json({ error: "Failed to update contract" });
  }
});

router.delete("/company-contracts/:id", requireAuth, requirePermission("company_contracts.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.update(companyContractsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(companyContractsTable.id, id), isNull(companyContractsTable.deletedAt)))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "company_contract.deleted",
      resource: "company_contract",
      resourceId: id,
      ipAddress: req.ip,
    });

    res.sendStatus(204);
  } catch (err) {
    console.error("[company-contracts] delete:", err);
    res.status(500).json({ error: "Failed to delete contract" });
  }
});

router.get("/company-contracts/:id/file", requireAuth, requirePermission("company_contracts.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(companyContractsTable)
      .where(and(eq(companyContractsTable.id, id), isNull(companyContractsTable.deletedAt)));
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
    console.error("[company-contracts] download:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download file" });
  }
});

export default router;
