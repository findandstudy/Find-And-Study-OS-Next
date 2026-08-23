/**
 * portalUniversityExclusions.ts — Exclusive Bölge (uyruk istisnası) Kuralları CRUD
 *
 * Kapsam:
 *   GET    /portal-automation/university-exclusions?universityKey=...        — liste (soft-delete hariç)
 *   GET    /portal-automation/university-exclusions/nationality-suggestions  — öğrenci uyrukları (DISTINCT)
 *   POST   /portal-automation/university-exclusions                          — kural ekle
 *   PATCH  /portal-automation/university-exclusions/:id                      — güncelle (uyruk/acente/not/enable)
 *   DELETE /portal-automation/university-exclusions/:id                      — soft delete (deletedAt)
 *
 * Kurallar: validate+getValidated (ASLA req.body), zod, logAudit,
 *           requireRole(...ADMIN_ROLES), soft-delete, unique (universityKey,nationality)→409.
 */

import { Router, type IRouter } from "express";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  portalUniversityExclusionsTable,
  studentsTable,
} from "@workspace/db";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { getValidated, validate } from "../middlewares/validate";

const router: IRouter = Router();

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type IdSchemas = { params: typeof idParamsSchema };

type ExclusionRow = typeof portalUniversityExclusionsTable.$inferSelect;

function serialize(row: ExclusionRow) {
  return {
    id: row.id,
    universityKey: row.universityKey,
    nationality: row.nationality,
    agencyName: row.agencyName,
    note: row.note,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /portal-automation/university-exclusions/nationality-suggestions
// DISTINCT student nationalities — used as an autocomplete source (free text
// is still allowed by the client).
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/university-exclusions/nationality-suggestions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const rows = await db
      .selectDistinct({ nationality: studentsTable.nationality })
      .from(studentsTable)
      .where(
        and(
          isNotNull(studentsTable.nationality),
          sql`length(trim(${studentsTable.nationality})) > 0`,
        ),
      )
      .orderBy(asc(studentsTable.nationality));

    res.json(
      rows
        .map((r) => (r.nationality ?? "").trim())
        .filter((n) => n.length > 0),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/university-exclusions?universityKey=...
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  universityKey: z.string().min(1).optional(),
});
type ListSchemas = { query: typeof listQuerySchema };

router.get(
  "/portal-automation/university-exclusions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: listQuerySchema }),
  async (req, res): Promise<void> => {
    const { universityKey } = getValidated<ListSchemas>(req).query;

    const rows = await db
      .select()
      .from(portalUniversityExclusionsTable)
      .where(
        and(
          isNull(portalUniversityExclusionsTable.deletedAt),
          universityKey
            ? eq(portalUniversityExclusionsTable.universityKey, universityKey)
            : undefined,
        ),
      )
      .orderBy(asc(portalUniversityExclusionsTable.id));

    res.json(rows.map(serialize));
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/university-exclusions
// ---------------------------------------------------------------------------
const createBodySchema = z.object({
  universityKey: z.string().min(1),
  nationality: z.string().min(1),
  agencyName: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
type CreateSchemas = { body: typeof createBodySchema };

router.post(
  "/portal-automation/university-exclusions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: createBodySchema }),
  async (req, res): Promise<void> => {
    const body = getValidated<CreateSchemas>(req).body;
    const user = req.user!;

    const nationality = body.nationality.trim();
    const universityKey = body.universityKey.trim();

    // Uniqueness: one active rule per (universityKey, nationality).
    // Match is case-insensitive (Phase 1 detection is also case-insensitive).
    const [existing] = await db
      .select({ id: portalUniversityExclusionsTable.id })
      .from(portalUniversityExclusionsTable)
      .where(
        and(
          eq(portalUniversityExclusionsTable.universityKey, universityKey),
          sql`lower(${portalUniversityExclusionsTable.nationality}) = lower(${nationality})`,
          isNull(portalUniversityExclusionsTable.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      res.status(409).json({
        error: "DUPLICATE_NATIONALITY",
        message: `An exclusion for '${nationality}' already exists for '${universityKey}'`,
      });
      return;
    }

    const [row] = await db
      .insert(portalUniversityExclusionsTable)
      .values({
        universityKey,
        nationality,
        agencyName: body.agencyName?.trim() || null,
        note: body.note?.trim() || null,
        enabled: body.enabled ?? true,
      })
      .returning();

    logAudit(
      user.id,
      "create_portal_university_exclusion",
      "portal_university_exclusion",
      row.id,
      {
        universityKey: row.universityKey,
        nationality: row.nationality,
        agencyName: row.agencyName,
      },
      req.ip,
    );

    res.status(201).json(serialize(row));
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-automation/university-exclusions/:id
// ---------------------------------------------------------------------------
const updateBodySchema = z
  .object({
    nationality: z.string().min(1).optional(),
    agencyName: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field is required",
  });
type UpdateSchemas = {
  params: typeof idParamsSchema;
  body: typeof updateBodySchema;
};

router.patch(
  "/portal-automation/university-exclusions/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: updateBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<UpdateSchemas>(req).params;
    const body = getValidated<UpdateSchemas>(req).body;
    const user = req.user!;

    const [existing] = await db
      .select()
      .from(portalUniversityExclusionsTable)
      .where(
        and(
          eq(portalUniversityExclusionsTable.id, id),
          isNull(portalUniversityExclusionsTable.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const nationality =
      body.nationality !== undefined ? body.nationality.trim() : undefined;

    // If the nationality changes, re-check uniqueness against other rows.
    if (nationality && nationality.toLowerCase() !== existing.nationality.toLowerCase()) {
      const [clash] = await db
        .select({ id: portalUniversityExclusionsTable.id })
        .from(portalUniversityExclusionsTable)
        .where(
          and(
            eq(
              portalUniversityExclusionsTable.universityKey,
              existing.universityKey,
            ),
            sql`lower(${portalUniversityExclusionsTable.nationality}) = lower(${nationality})`,
            isNull(portalUniversityExclusionsTable.deletedAt),
          ),
        )
        .limit(1);
      if (clash) {
        res.status(409).json({
          error: "DUPLICATE_NATIONALITY",
          message: `An exclusion for '${nationality}' already exists for '${existing.universityKey}'`,
        });
        return;
      }
    }

    const [row] = await db
      .update(portalUniversityExclusionsTable)
      .set({
        ...(nationality !== undefined && { nationality }),
        ...(body.agencyName !== undefined && {
          agencyName: body.agencyName?.trim() || null,
        }),
        ...(body.note !== undefined && { note: body.note?.trim() || null }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(eq(portalUniversityExclusionsTable.id, id))
      .returning();

    logAudit(
      user.id,
      "update_portal_university_exclusion",
      "portal_university_exclusion",
      id,
      {
        ...(nationality !== undefined && { nationality }),
        ...(body.agencyName !== undefined && { agencyName: body.agencyName }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      },
      req.ip,
    );

    res.json(serialize(row));
  },
);

// ---------------------------------------------------------------------------
// DELETE /portal-automation/university-exclusions/:id  — soft delete
// ---------------------------------------------------------------------------
router.delete(
  "/portal-automation/university-exclusions/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const user = req.user!;

    const [existing] = await db
      .select({ id: portalUniversityExclusionsTable.id })
      .from(portalUniversityExclusionsTable)
      .where(
        and(
          eq(portalUniversityExclusionsTable.id, id),
          isNull(portalUniversityExclusionsTable.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    await db
      .update(portalUniversityExclusionsTable)
      .set({ deletedAt: new Date() })
      .where(eq(portalUniversityExclusionsTable.id, id));

    logAudit(
      user.id,
      "delete_portal_university_exclusion",
      "portal_university_exclusion",
      id,
      {},
      req.ip,
    );

    res.json({ ok: true });
  },
);

export default router;
