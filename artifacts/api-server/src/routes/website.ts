import express, { Router, json, type Request, type Response } from "express";
import { publicFormLimiter } from "../lib/limiters";
import { getClientIp } from "../lib/clientIp";
import { db } from "@workspace/db";
import { eq, asc, desc, inArray, and } from "drizzle-orm";
import type { AnyPgTable, AnyPgColumn } from "drizzle-orm/pg-core";
import {
  websitePagesTable,
  websitePageVersionsTable,
  websitePageBlocksTable,
  websiteNavigationMenusTable,
  websiteNavigationItemsTable,
  websiteThemeTokensTable,
  websiteGlobalComponentsTable,
  websiteFormsTable,
  websiteFormFieldsTable,
  websiteFormSubmissionsTable,
  websiteBlogPostsTable,
  websiteBlogCategoriesTable,
  websiteBlogTagsTable,
  websiteBlogPostTagsTable,
  websiteCollectionsOfficesTable,
  websiteCollectionsTeamMembersTable,
  websiteCollectionsFaqsTable,
  websiteCollectionsTestimonialsTable,
  usersTable,
  settingsTable,
  integrationsTable,
  leadsTable,
  pipelineStagesTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { applyLeadAssignmentRules } from "../lib/leadAssignment";
import { findOrUpsertPublicLead } from "../lib/leadDedup";
import {
  emptySummary,
  tallyResult,
  nextAvailableSlug,
  isValidConflictStrategy,
  ImportValidationError,
  type ConflictStrategy,
} from "../lib/exportImport";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  XLSX_CONTENT_TYPE,
  formColumns,
  formFieldColumns,
  buildFormsReferenceSheets,
  VALID_FIELD_TYPES as XLSX_VALID_FIELD_TYPES,
  VALID_SUBMIT_ACTIONS as XLSX_VALID_SUBMIT_ACTIONS,
  FORMS_KIND,
  type FormsCatalog,
} from "../lib/exportImportExcel";

const router = Router();
const WEBSITE_ROLES = ["super_admin", "admin"] as const;
const adminOnly = [requireAuth, requireRole(...WEBSITE_ROLES)] as const;

const VALID_BLOCK_TYPES = new Set([
  "hero", "rich_text", "stats_strip", "feature_cards", "icon_cards",
  "cta_banner", "faq", "team_grid", "office_list", "logo_grid",
  "testimonials", "section_title", "spacer_divider", "global_block",
]);

function registerCrud(
  basePath: string,
  table: AnyPgTable,
  idCol: AnyPgColumn,
  orderCol?: AnyPgColumn
): void {
  router.get(basePath, ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
    try {
      const rows = await db.select().from(table).orderBy(orderCol ? asc(orderCol) : asc(idCol));
      res.json(rows);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  router.get(`${basePath}/:id`, ...adminOnly, async (req: Request, res: Response): Promise<void> => {
    try {
      const [row] = await db.select().from(table).where(eq(idCol, Number(req.params.id)));
      if (!row) { res.status(404).json({ error: "Not found" }); return; }
      res.json(row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  router.post(basePath, ...adminOnly, async (req: Request, res: Response): Promise<void> => {
    try {
      const [row] = await db.insert(table).values(req.body).returning();
      res.status(201).json(row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  router.put(`${basePath}/:id`, ...adminOnly, async (req: Request, res: Response): Promise<void> => {
    try {
      const [row] = await db.update(table).set(req.body).where(eq(idCol, Number(req.params.id))).returning();
      if (!row) { res.status(404).json({ error: "Not found" }); return; }
      res.json(row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  router.delete(`${basePath}/:id`, ...adminOnly, async (req: Request, res: Response): Promise<void> => {
    try {
      const [row] = await db.delete(table).where(eq(idCol, Number(req.params.id))).returning();
      if (!row) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ success: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });
}

registerCrud("/website/pages", websitePagesTable, websitePagesTable.id, websitePagesTable.sortOrder);
registerCrud("/website/page-versions", websitePageVersionsTable, websitePageVersionsTable.id);
registerCrud("/website/page-blocks", websitePageBlocksTable, websitePageBlocksTable.id, websitePageBlocksTable.sortOrder);
registerCrud("/website/navigation-menus", websiteNavigationMenusTable, websiteNavigationMenusTable.id);
registerCrud("/website/navigation-items", websiteNavigationItemsTable, websiteNavigationItemsTable.id, websiteNavigationItemsTable.sortOrder);
registerCrud("/website/theme-tokens", websiteThemeTokensTable, websiteThemeTokensTable.id);
registerCrud("/website/global-components", websiteGlobalComponentsTable, websiteGlobalComponentsTable.id);
registerCrud("/website/forms", websiteFormsTable, websiteFormsTable.id);
registerCrud("/website/form-fields", websiteFormFieldsTable, websiteFormFieldsTable.id, websiteFormFieldsTable.sortOrder);
registerCrud("/website/blog-posts", websiteBlogPostsTable, websiteBlogPostsTable.id);
registerCrud("/website/blog-categories", websiteBlogCategoriesTable, websiteBlogCategoriesTable.id, websiteBlogCategoriesTable.sortOrder);
registerCrud("/website/blog-tags", websiteBlogTagsTable, websiteBlogTagsTable.id);
registerCrud("/website/blog-post-tags", websiteBlogPostTagsTable, websiteBlogPostTagsTable.id);
registerCrud("/website/collections/offices", websiteCollectionsOfficesTable, websiteCollectionsOfficesTable.id, websiteCollectionsOfficesTable.sortOrder);
registerCrud("/website/collections/team-members", websiteCollectionsTeamMembersTable, websiteCollectionsTeamMembersTable.id, websiteCollectionsTeamMembersTable.sortOrder);
registerCrud("/website/collections/faqs", websiteCollectionsFaqsTable, websiteCollectionsFaqsTable.id, websiteCollectionsFaqsTable.sortOrder);
registerCrud("/website/collections/testimonials", websiteCollectionsTestimonialsTable, websiteCollectionsTestimonialsTable.id, websiteCollectionsTestimonialsTable.sortOrder);

router.get("/website/pages/:pageId/blocks", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select().from(websitePageBlocksTable)
      .where(eq(websitePageBlocksTable.pageId, Number(req.params.pageId)))
      .orderBy(asc(websitePageBlocksTable.sortOrder));
    res.json(rows);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/pages/:pageId/versions", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select({
      id: websitePageVersionsTable.id,
      pageId: websitePageVersionsTable.pageId,
      versionNumber: websitePageVersionsTable.versionNumber,
      blocksSnapshot: websitePageVersionsTable.blocksSnapshot,
      metaSnapshot: websitePageVersionsTable.metaSnapshot,
      publishedAt: websitePageVersionsTable.publishedAt,
      createdBy: websitePageVersionsTable.createdBy,
      createdAt: websitePageVersionsTable.createdAt,
      authorFirstName: usersTable.firstName,
      authorLastName: usersTable.lastName,
      authorEmail: usersTable.email,
    })
      .from(websitePageVersionsTable)
      .leftJoin(usersTable, eq(websitePageVersionsTable.createdBy, usersTable.id))
      .where(eq(websitePageVersionsTable.pageId, Number(req.params.pageId)))
      .orderBy(desc(websitePageVersionsTable.versionNumber));
    res.json(rows);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

// --- Export / Import (Task #202) ---------------------------------------
// Lossless Excel (.xlsx) round-trip for Web-to-Lead forms together with
// their fields. The workbook has two sheets — `Forms` and `Fields` —
// linked by `Form slug`. Each form is created with its fields inside a
// single database transaction so a failure on any field rolls back the
// form too. Slugs are the cross-installation identity; ids, timestamps,
// and submission counts are stripped. A separate `/template` endpoint
// hands back an empty workbook with dropdowns pulled live from current
// pipeline stages and existing lead sources.

function normalizeFormSlug(slug: string): string {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function loadFormDropdownOptions(): Promise<FormsCatalog> {
  const [stages, sources, pages] = await Promise.all([
    db.select({ key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.entityType, "lead"))
      .orderBy(asc(pipelineStagesTable.sortOrder)),
    db.select({ src: websiteFormsTable.crmSource }).from(websiteFormsTable),
    db.select({ slug: websitePagesTable.slug })
      .from(websitePagesTable)
      .orderBy(asc(websitePagesTable.sortOrder), asc(websitePagesTable.slug)),
  ]);
  const stageKeys = Array.from(new Set(stages.map((s) => s.key).filter(Boolean) as string[]));
  const sourceSet = new Set<string>();
  for (const r of sources) if (r.src) sourceSet.add(r.src);
  // Always include a sensible default list so the dropdown is never empty.
  ["website", "embed", "manual", "import", "referral"].forEach((s) => sourceSet.add(s));
  const pageTags = Array.from(new Set(pages.map((p) => p.slug).filter(Boolean) as string[])).sort();
  return { pipelineStages: stageKeys, crmSources: Array.from(sourceSet).sort(), pageTags };
}

function formsExportRows(forms: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return forms.map((f) => ({
    name: f.name, slug: f.slug, description: f.description,
    submitAction: f.submitAction, submitEmail: f.submitEmail,
    submitWebhookUrl: f.submitWebhookUrl, successMessage: f.successMessage,
    errorMessage: f.errorMessage, crmSource: f.crmSource,
    crmPipelineStage: f.crmPipelineStage, pageSourceTag: f.pageSourceTag,
    isActive: f.isActive,
  }));
}

function fieldsExportRows(
  forms: Array<{ id: number; slug: string }>,
  fields: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const slugByFormId = new Map(forms.map((f) => [f.id, f.slug] as const));
  return fields.map((fld) => ({
    form_slug: slugByFormId.get(fld.formId as number) ?? "",
    fieldType: fld.fieldType, label: fld.label, name: fld.name,
    placeholder: fld.placeholder, isRequired: fld.isRequired,
    sortOrder: fld.sortOrder, validationRules: fld.validationRules,
    options: fld.options,
  }));
}

router.post("/website/forms/export", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const { ids } = (req.body || {}) as { ids?: unknown };
    let forms;
    if (Array.isArray(ids) && ids.length > 0) {
      const numericIds = ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
      if (numericIds.length === 0) return void res.status(400).json({ error: "ids must be a non-empty array of positive integers" });
      forms = await db.select().from(websiteFormsTable).where(inArray(websiteFormsTable.id, numericIds)).orderBy(asc(websiteFormsTable.name));
    } else {
      forms = await db.select().from(websiteFormsTable).orderBy(asc(websiteFormsTable.name));
    }

    const allFields = forms.length > 0
      ? await db.select().from(websiteFormFieldsTable)
          .where(inArray(websiteFormFieldsTable.formId, forms.map((f) => f.id)))
          .orderBy(asc(websiteFormFieldsTable.formId), asc(websiteFormFieldsTable.sortOrder))
      : [];

    const opts = await loadFormDropdownOptions();
    const buf = await buildWorkbookBuffer({
      sheets: [
        { name: "Forms", columns: formColumns(opts.pipelineStages, opts.crmSources),
          rows: formsExportRows(forms as Array<Record<string, unknown>>) },
        { name: "Fields", columns: formFieldColumns(),
          rows: fieldsExportRows(forms as Array<{ id: number; slug: string }>, allFields as Array<Record<string, unknown>>) },
        ...buildFormsReferenceSheets(opts),
      ],
      meta: { kind: FORMS_KIND, version: "1", exportedAt: new Date().toISOString() },
    });
    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="website-forms-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/forms/template", ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
  try {
    const opts = await loadFormDropdownOptions();
    const pick = <T,>(arr: readonly T[], i: number): T | undefined => arr[i] ?? arr[0];
    const slugSuffix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stage = pick(opts.pipelineStages, 0);
    const altStage = pick(opts.pipelineStages, 1);
    const sourceWebsite = opts.crmSources.includes("website") ? "website" : pick(opts.crmSources, 0);
    const sourceEmbed = opts.crmSources.includes("embed") ? "embed" : pick(opts.crmSources, 0);
    const pageTag = pick(opts.pageTags, 0);

    // Three diverse example forms covering all three submit actions.
    // Every row is plainly marked EXAMPLE and shipped with isActive=false
    // so an accidental re-import never publishes a live form.
    const exampleForms = [
      {
        name: "EXAMPLE — Contact form (delete or edit me)",
        slug: `example-contact-${slugSuffix}`,
        description: "Simple contact form delivered to a shared inbox.",
        submitAction: "email",
        submitEmail: "leads@example.com",
        submitWebhookUrl: "",
        successMessage: "Thank you — we will be in touch shortly.",
        errorMessage: "Sorry, something went wrong. Please try again.",
        crmSource: sourceWebsite ?? "",
        crmPipelineStage: stage ?? "",
        pageSourceTag: pageTag ?? "contact",
        isActive: false,
      },
      {
        name: "EXAMPLE — Webhook lead capture (delete or edit me)",
        slug: `example-webhook-${slugSuffix}`,
        description: "Posts every submission to an external webhook.",
        submitAction: "webhook",
        submitEmail: "",
        submitWebhookUrl: "https://example.com/api/leads",
        successMessage: "Got it!",
        errorMessage: "Please try again.",
        crmSource: sourceEmbed ?? "",
        crmPipelineStage: stage ?? "",
        pageSourceTag: pageTag ?? "",
        isActive: false,
      },
      {
        name: "EXAMPLE — CRM lead form (delete or edit me)",
        slug: `example-crm-${slugSuffix}`,
        description: "Creates a lead in the CRM at the chosen pipeline stage.",
        submitAction: "crm",
        submitEmail: "",
        submitWebhookUrl: "",
        successMessage: "Thanks — your application has been received.",
        errorMessage: "Submission failed. Please retry.",
        crmSource: sourceWebsite ?? "",
        crmPipelineStage: altStage ?? stage ?? "",
        pageSourceTag: pageTag ?? "",
        isActive: false,
      },
    ];

    // Matching field rows, linked to the example forms by `form_slug`.
    // Demonstrates required vs optional fields, validation rules, and
    // select options JSON shape.
    const ef = (i: number) => exampleForms[i].slug;
    const exampleFields = [
      // Contact form: name, email, message
      { form_slug: ef(0), fieldType: "text", label: "Full name", name: "full_name",
        placeholder: "Your name", isRequired: true, sortOrder: 1,
        validationRules: { minLength: 2, maxLength: 80 }, options: [] },
      { form_slug: ef(0), fieldType: "email", label: "Email", name: "email",
        placeholder: "you@example.com", isRequired: true, sortOrder: 2,
        validationRules: {}, options: [] },
      { form_slug: ef(0), fieldType: "textarea", label: "Message", name: "message",
        placeholder: "How can we help?", isRequired: false, sortOrder: 3,
        validationRules: { maxLength: 1000 }, options: [] },
      // Webhook form: phone + interest select
      { form_slug: ef(1), fieldType: "phone", label: "Phone", name: "phone",
        placeholder: "+90 …", isRequired: true, sortOrder: 1,
        validationRules: {}, options: [] },
      { form_slug: ef(1), fieldType: "select", label: "Interested in", name: "interest",
        placeholder: "", isRequired: true, sortOrder: 2,
        validationRules: {},
        options: [
          { label: "Undergraduate", value: "undergraduate" },
          { label: "Postgraduate", value: "postgraduate" },
          { label: "Language course", value: "language" },
        ] },
      // CRM form: name + email + consent checkbox
      { form_slug: ef(2), fieldType: "text", label: "Full name", name: "full_name",
        placeholder: "", isRequired: true, sortOrder: 1,
        validationRules: { minLength: 2 }, options: [] },
      { form_slug: ef(2), fieldType: "email", label: "Email", name: "email",
        placeholder: "", isRequired: true, sortOrder: 2,
        validationRules: {}, options: [] },
      { form_slug: ef(2), fieldType: "checkbox", label: "I agree to be contacted", name: "consent",
        placeholder: "", isRequired: true, sortOrder: 3,
        validationRules: {}, options: [] },
    ];

    const buf = await buildWorkbookBuffer({
      sheets: [
        { name: "Forms", columns: formColumns(opts.pipelineStages, opts.crmSources),
          rows: exampleForms as Array<Record<string, unknown>> },
        { name: "Fields", columns: formFieldColumns(),
          rows: exampleFields as Array<Record<string, unknown>> },
        ...buildFormsReferenceSheets(opts),
      ],
      meta: { kind: FORMS_KIND, version: "1", exportedAt: new Date().toISOString() },
    });
    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="website-forms-template.xlsx"`);
    res.send(buf);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post(
  "/website/forms/import",
  ...adminOnly,
  express.raw({ type: XLSX_CONTENT_TYPE, limit: "2mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const conflict: ConflictStrategy = isValidConflictStrategy(req.query.conflict) ? req.query.conflict : "skip";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return void res.status(400).json({ error: "Upload an .xlsx file with Content-Type " + XLSX_CONTENT_TYPE });
    }

    const opts = await loadFormDropdownOptions();
    let parsed;
    try {
      parsed = await parseWorkbookBuffer(req.body, { expectedKind: FORMS_KIND }, {
        Forms: formColumns(opts.pipelineStages, opts.crmSources),
        Fields: formFieldColumns(),
      });
    } catch (err) {
      const e = err as ImportValidationError;
      return void res.status(e.status || 400).json({ error: e.message });
    }

    const rawForms = parsed.sheets.get("Forms")?.rows ?? [];
    const rawFields = parsed.sheets.get("Fields")?.rows ?? [];

    // Group fields by normalised form slug so the order in the Fields
    // sheet doesn't have to match the Forms sheet.
    const fieldsBySlug = new Map<string, Array<Record<string, unknown>>>();
    for (const f of rawFields) {
      const slug = normalizeFormSlug(String(f.form_slug ?? ""));
      if (!slug) continue;
      const list = fieldsBySlug.get(slug) ?? [];
      list.push(f);
      fieldsBySlug.set(slug, list);
    }

    const summary = emptySummary(rawForms.length);
    const validSubmitActions = new Set<string>(XLSX_VALID_SUBMIT_ACTIONS);
    const validFieldTypes = new Set<string>(XLSX_VALID_FIELD_TYPES);

    for (let i = 0; i < rawForms.length; i++) {
      const item = rawForms[i];
      try {
        if (!item.name || typeof item.name !== "string") throw new Error("Name is required");
        if (!item.slug || typeof item.slug !== "string") throw new Error("Slug is required");
        const slug = normalizeFormSlug(item.slug);
        if (!slug) throw new Error("Slug is invalid");
        if (typeof item.submitAction !== "string" || !validSubmitActions.has(item.submitAction)) {
          throw new Error(`Invalid submitAction "${String(item.submitAction ?? "")}". Allowed: ${Array.from(validSubmitActions).join(", ")}.`);
        }
        const submitAction = item.submitAction;

        const formValues = {
          name: item.name,
          slug,
          description: (item.description as string | null) ?? null,
          submitAction,
          submitEmail: (item.submitEmail as string | null) ?? null,
          submitWebhookUrl: (item.submitWebhookUrl as string | null) ?? null,
          successMessage: (item.successMessage as string | null) ?? null,
          errorMessage: (item.errorMessage as string | null) ?? null,
          crmSource: (item.crmSource as string | null) ?? null,
          crmPipelineStage: (item.crmPipelineStage as string | null) ?? null,
          pageSourceTag: (item.pageSourceTag as string | null) ?? null,
          // Blank cells default to active so the template stays low-friction;
          // an explicit FALSE in the cell still deactivates the form.
          isActive: item.isActive === false ? false : true,
        };

        const matchingFields = fieldsBySlug.get(slug) ?? [];
        const fieldRows = matchingFields.map((f, idx) => {
          if (!f.label || typeof f.label !== "string") throw new Error(`Field row ${idx + 1}: Label is required`);
          if (!f.name || typeof f.name !== "string") throw new Error(`Field row ${idx + 1}: Name is required`);
          if (typeof f.fieldType !== "string" || !validFieldTypes.has(f.fieldType)) {
            throw new Error(`Field row ${idx + 1}: Invalid fieldType "${String(f.fieldType ?? "")}". Allowed: ${Array.from(validFieldTypes).join(", ")}.`);
          }
          const fieldType = f.fieldType;
          return {
            fieldType,
            label: f.label,
            name: f.name,
            placeholder: (f.placeholder as string | null) ?? null,
            isRequired: f.isRequired === true,
            validationRules: (f.validationRules as Record<string, unknown>) ?? {},
            options: (f.options as unknown[]) ?? [],
            sortOrder: typeof f.sortOrder === "number" ? f.sortOrder : idx,
          };
        });

        const [existing] = await db.select().from(websiteFormsTable).where(eq(websiteFormsTable.slug, slug));

        if (existing && conflict === "skip") {
          tallyResult(summary, { index: i, slug, status: "skipped" });
          continue;
        }

        let finalSlug = slug;
        let status: "created" | "updated" | "renamed" = "created";

        if (existing && conflict === "overwrite") {
          await db.transaction(async (tx) => {
            await tx.update(websiteFormsTable).set(formValues).where(eq(websiteFormsTable.id, existing.id));
            await tx.delete(websiteFormFieldsTable).where(eq(websiteFormFieldsTable.formId, existing.id));
            if (fieldRows.length > 0) {
              await tx.insert(websiteFormFieldsTable).values(fieldRows.map((f) => ({ ...f, formId: existing.id })));
            }
          });
          status = "updated";
        } else {
          if (existing && conflict === "rename") {
            finalSlug = await nextAvailableSlug(slug, async (cand) => {
              const [hit] = await db.select({ id: websiteFormsTable.id }).from(websiteFormsTable).where(eq(websiteFormsTable.slug, cand));
              return !!hit;
            });
            status = "renamed";
          }
          await db.transaction(async (tx) => {
            const [created] = await tx.insert(websiteFormsTable).values({ ...formValues, slug: finalSlug }).returning();
            if (fieldRows.length > 0) {
              await tx.insert(websiteFormFieldsTable).values(fieldRows.map((f) => ({ ...f, formId: created.id })));
            }
          });
        }

        tallyResult(summary, status === "renamed"
          ? { index: i, slug, status, finalSlug }
          : { index: i, slug: finalSlug, status });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tallyResult(summary, { index: i, slug: typeof item.slug === "string" ? item.slug : null, status: "error", error: msg });
      }
    }

    res.json(summary);
  },
);

router.get("/website/forms/:formId/fields", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select().from(websiteFormFieldsTable)
      .where(eq(websiteFormFieldsTable.formId, Number(req.params.formId)))
      .orderBy(asc(websiteFormFieldsTable.sortOrder));
    res.json(rows);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/menus/:menuId/items", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select().from(websiteNavigationItemsTable)
      .where(eq(websiteNavigationItemsTable.menuId, Number(req.params.menuId)))
      .orderBy(asc(websiteNavigationItemsTable.sortOrder));
    res.json(rows);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/pages/:id/publish", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const pageId = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [page] = await tx.update(websitePagesTable)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(websitePagesTable.id, pageId))
        .returning();
      if (!page) return null;

      const blocks = await tx.select().from(websitePageBlocksTable)
        .where(eq(websitePageBlocksTable.pageId, pageId))
        .orderBy(asc(websitePageBlocksTable.sortOrder));

      const existingVersions = await tx.select().from(websitePageVersionsTable)
        .where(eq(websitePageVersionsTable.pageId, pageId))
        .orderBy(desc(websitePageVersionsTable.versionNumber));

      const nextVersion = (existingVersions[0]?.versionNumber || 0) + 1;

      const [version] = await tx.insert(websitePageVersionsTable).values({
        pageId,
        versionNumber: nextVersion,
        blocksSnapshot: blocks,
        metaSnapshot: { title: page.title, metaTitle: page.metaTitle, metaDescription: page.metaDescription },
        publishedAt: new Date(),
        createdBy: req.user?.id,
      }).returning();

      return { page, version };
    });
    if (!result) return void res.status(404).json({ error: "Not found" });
    res.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/pages/:id/unpublish", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [page] = await db.update(websitePagesTable)
      .set({ status: "draft", publishedAt: null })
      .where(eq(websitePagesTable.id, Number(req.params.id)))
      .returning();
    if (!page) return void res.status(404).json({ error: "Not found" });
    res.json(page);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/blog-posts/:id/publish", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [post] = await db.update(websiteBlogPostsTable)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(websiteBlogPostsTable.id, Number(req.params.id)))
      .returning();
    if (!post) return void res.status(404).json({ error: "Not found" });
    res.json(post);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/blog-posts/:id/unpublish", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [post] = await db.update(websiteBlogPostsTable)
      .set({ status: "draft", publishedAt: null })
      .where(eq(websiteBlogPostsTable.id, Number(req.params.id)))
      .returning();
    if (!post) return void res.status(404).json({ error: "Not found" });
    res.json(post);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.put("/website/theme-tokens/batch", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const tokens: { tokenGroup: string; tokenKey: string; tokenValue: string | null; description?: string }[] = req.body.tokens;
    if (!Array.isArray(tokens)) return void res.status(400).json({ error: "tokens array required" });
    for (const t of tokens) {
      if (typeof t.tokenGroup !== "string" || !t.tokenGroup || typeof t.tokenKey !== "string" || !t.tokenKey) {
        return void res.status(400).json({ error: "Each token must have non-empty tokenGroup and tokenKey strings" });
      }
      if (t.tokenValue !== null && typeof t.tokenValue !== "string") {
        return void res.status(400).json({ error: "tokenValue must be a string or null" });
      }
    }
    const results = await db.transaction(async (tx) => {
      const out = [];
      for (const t of tokens) {
        const existing = await tx.select().from(websiteThemeTokensTable)
          .where(eq(websiteThemeTokensTable.tokenGroup, t.tokenGroup))
          .then(rows => rows.find(r => r.tokenKey === t.tokenKey));

        if (t.tokenValue === null || t.tokenValue === "") {
          if (existing) {
            await tx.delete(websiteThemeTokensTable).where(eq(websiteThemeTokensTable.id, existing.id));
          }
          continue;
        }

        if (existing) {
          const [updated] = await tx.update(websiteThemeTokensTable)
            .set({ tokenValue: t.tokenValue, description: t.description || existing.description })
            .where(eq(websiteThemeTokensTable.id, existing.id))
            .returning();
          out.push(updated);
        } else {
          const [created] = await tx.insert(websiteThemeTokensTable)
            .values({ tokenGroup: t.tokenGroup, tokenKey: t.tokenKey, tokenValue: t.tokenValue, description: t.description })
            .returning();
          out.push(created);
        }
      }
      return out;
    });
    res.json(results);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/website/theme-tokens/all", ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
  try {
    await db.delete(websiteThemeTokensTable);
    res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

const DEFAULT_PAGES = [
  { title: "Home", slug: "home", sortOrder: 0, template: "home" },
  { title: "About", slug: "about", sortOrder: 1, template: "about" },
  { title: "Countries", slug: "countries", sortOrder: 2, template: "countries" },
  { title: "Programs", slug: "programs", sortOrder: 3, template: "programs" },
  { title: "Blog", slug: "blog", sortOrder: 4, template: "blog" },
  { title: "Contact", slug: "contact", sortOrder: 5, template: "contact" },
];

router.post("/website/pages/seed", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await db.select().from(websitePagesTable);
    if (existing.length > 0) return void res.json({ seeded: false, pages: existing });
    const pages = await db.insert(websitePagesTable).values(
      DEFAULT_PAGES.map(p => ({ ...p, status: "draft" as const, locale: "en", createdBy: req.user?.id }))
    ).returning();
    res.status(201).json({ seeded: true, pages });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/pages/:pageId/save-draft", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const pageId = Number(req.params.pageId);
    const { blocks, meta, translationsJson } = req.body;

    if (Array.isArray(blocks)) {
      const invalidBlock = blocks.find((b: { blockType: string }) => !VALID_BLOCK_TYPES.has(b.blockType));
      if (invalidBlock) {
        return void res.status(400).json({ error: `Invalid block type: ${invalidBlock.blockType}` });
      }
    }

    await db.transaction(async (tx) => {
      const pageUpdate: Record<string, unknown> = { status: "draft" };
      if (meta) Object.assign(pageUpdate, meta);
      if (translationsJson !== undefined) pageUpdate.translationsJson = translationsJson;
      await tx.update(websitePagesTable)
        .set(pageUpdate)
        .where(eq(websitePagesTable.id, pageId));

      if (Array.isArray(blocks)) {
        await tx.delete(websitePageBlocksTable).where(eq(websitePageBlocksTable.pageId, pageId));
        if (blocks.length > 0) {
          await tx.insert(websitePageBlocksTable).values(
            blocks.map((b: { blockType: string; content: Record<string, unknown>; settings?: Record<string, unknown>; sortOrder: number; isVisible: boolean }, i: number) => ({
              pageId,
              blockType: b.blockType,
              content: b.content || {},
              settings: b.settings || {},
              sortOrder: b.sortOrder ?? i,
              isVisible: b.isVisible ?? true,
            }))
          );
        }
      }
    });

    const [page] = await db.select().from(websitePagesTable).where(eq(websitePagesTable.id, pageId));
    const savedBlocks = await db.select().from(websitePageBlocksTable)
      .where(eq(websitePageBlocksTable.pageId, pageId))
      .orderBy(asc(websitePageBlocksTable.sortOrder));
    res.json({ page, blocks: savedBlocks });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.post("/website/pages/:pageId/restore-version/:versionId", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const pageId = Number(req.params.pageId);
    const versionId = Number(req.params.versionId);

    const [version] = await db.select().from(websitePageVersionsTable)
      .where(eq(websitePageVersionsTable.id, versionId));
    if (!version || version.pageId !== pageId) return void res.status(404).json({ error: "Version not found" });

    const snapshot = version.blocksSnapshot as Array<{
      blockType: string;
      content: Record<string, unknown>;
      settings: Record<string, unknown>;
      sortOrder: number;
      isVisible: boolean;
    }>;

    await db.transaction(async (tx) => {
      await tx.delete(websitePageBlocksTable).where(eq(websitePageBlocksTable.pageId, pageId));
      if (Array.isArray(snapshot) && snapshot.length > 0) {
        await tx.insert(websitePageBlocksTable).values(
          snapshot.map((b, i) => ({
            pageId,
            blockType: b.blockType,
            content: b.content || {},
            settings: b.settings || {},
            sortOrder: b.sortOrder ?? i,
            isVisible: b.isVisible ?? true,
          }))
        );
      }
      const metaSnap = version.metaSnapshot as Record<string, string> | null;
      if (metaSnap) {
        await tx.update(websitePagesTable)
          .set({ status: "draft", metaTitle: metaSnap.metaTitle || null, metaDescription: metaSnap.metaDescription || null })
          .where(eq(websitePagesTable.id, pageId));
      } else {
        await tx.update(websitePagesTable)
          .set({ status: "draft" })
          .where(eq(websitePagesTable.id, pageId));
      }
    });

    const [page] = await db.select().from(websitePagesTable).where(eq(websitePagesTable.id, pageId));
    const blocks = await db.select().from(websitePageBlocksTable)
      .where(eq(websitePageBlocksTable.pageId, pageId))
      .orderBy(asc(websitePageBlocksTable.sortOrder));
    res.json({ page, blocks });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

registerCrud("/website/form-submissions", websiteFormSubmissionsTable, websiteFormSubmissionsTable.id);

router.get("/website/forms/:formId/submissions", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const formId = Number(req.params.formId);
    const [{ count }] = await db.select({ count: sql<number>`count(*)` })
      .from(websiteFormSubmissionsTable)
      .where(eq(websiteFormSubmissionsTable.formId, formId));
    const rows = await db.select().from(websiteFormSubmissionsTable)
      .where(eq(websiteFormSubmissionsTable.formId, formId))
      .orderBy(desc(websiteFormSubmissionsTable.createdAt))
      .limit(limitNum).offset(offset);
    res.json({ data: rows, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/public/website-forms/:slug/check", async (req: Request, res: Response): Promise<void> => {
  try {
    const [form] = await db.select({ id: websiteFormsTable.id })
      .from(websiteFormsTable)
      .where(and(eq(websiteFormsTable.slug, String(req.params.slug)), eq(websiteFormsTable.isActive, true)));
    res.json({ exists: !!form });
  } catch {
    res.json({ exists: false });
  }
});

router.post("/public/website-forms/:slug/submit", publicFormLimiter, async (req: Request, res: Response): Promise<void> => {
  let formRecord: typeof websiteFormsTable.$inferSelect | undefined;
  try {
    const { slug } = req.params;
    const [form] = await db.select().from(websiteFormsTable)
      .where(eq(websiteFormsTable.slug, String(slug)));
    if (!form || !form.isActive) return void res.status(404).json({ error: "Form not found" });
    formRecord = form;

    const { _hp, ...formData } = req.body;
    if (_hp) return void res.json({ success: true });

    const fields = await db.select().from(websiteFormFieldsTable)
      .where(eq(websiteFormFieldsTable.formId, form.id))
      .orderBy(asc(websiteFormFieldsTable.sortOrder));

    for (const field of fields) {
      const val = formData[field.name];
      if (field.isRequired && !val) {
        return void res.status(400).json({ error: `${field.label} is required` });
      }
      if (val) {
        const strVal = String(val);
        const rules = (field.validationRules || {}) as Record<string, string>;

        if (field.fieldType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strVal)) {
          return void res.status(400).json({ error: `${field.label} must be a valid email address` });
        }
        if (field.fieldType === "url" && !/^https?:\/\/.+/.test(strVal)) {
          return void res.status(400).json({ error: `${field.label} must be a valid URL` });
        }
        if (field.fieldType === "phone" && !/^[+\d\s()-]{6,20}$/.test(strVal)) {
          return void res.status(400).json({ error: `${field.label} must be a valid phone number` });
        }
        if (rules.minLength && strVal.length < Number(rules.minLength)) {
          return void res.status(400).json({ error: `${field.label} must be at least ${rules.minLength} characters` });
        }
        if (rules.maxLength && strVal.length > Number(rules.maxLength)) {
          return void res.status(400).json({ error: `${field.label} must be at most ${rules.maxLength} characters` });
        }
        if (rules.pattern) {
          try {
            if (!new RegExp(rules.pattern).test(strVal)) {
              return void res.status(400).json({ error: `${field.label} does not match the required format` });
            }
          } catch {}
        }
      }
    }

    let leadId: number | null = null;
    if (formData.email && formData.firstName) {
      let initialStatus = "new";
      if (form.crmPipelineStage) {
        const [stage] = await db.select({ key: pipelineStagesTable.key })
          .from(pipelineStagesTable)
          .where(and(
            eq(pipelineStagesTable.entityType, "lead"),
            eq(pipelineStagesTable.key, form.crmPipelineStage),
          ));
        if (stage) initialStatus = stage.key;
      }
      const resolvedSource = form.crmSource || `website-form:${form.slug}`;
      const { lead } = await findOrUpsertPublicLead({
        source: resolvedSource,
        uniqueKey: { kind: "emailSource" },
        fields: {
          firstName: String(formData.firstName).slice(0, 100),
          lastName: String(formData.lastName || "").slice(0, 100),
          email: String(formData.email).slice(0, 255),
          phone: formData.phone ? String(formData.phone).slice(0, 50) : null,
        },
        extras: { initialStatus },
        ip: req.ip,
      });
      leadId = lead.id;
    }

    const submissionData = { ...formData };
    if (form.pageSourceTag) submissionData._pageSourceTag = form.pageSourceTag;

    const [submission] = await db.insert(websiteFormSubmissionsTable).values({
      formId: form.id,
      data: submissionData,
      sourceUrl: req.headers.referer || null,
      ipAddress: (getClientIp(req) ?? "").slice(0, 45),
      userAgent: (req.headers["user-agent"] || "").slice(0, 500),
      leadId,
      status: "new",
    }).returning();

    if (form.submitAction === "webhook" && form.submitWebhookUrl) {
      const webhookUrl = form.submitWebhookUrl;
      const isValidWebhook = /^https:\/\/[^\/]/.test(webhookUrl) && !/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/i.test(webhookUrl);
      if (!isValidWebhook) {
        console.warn(`[FORM] Blocked webhook to private/non-HTTPS URL: ${webhookUrl}`);
      } else {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formSlug: form.slug, submissionId: submission.id, data: formData }),
        }).catch(err => console.error(`[FORM] Webhook delivery failed for ${form.slug}:`, err.message));
      }
    }

    if (form.submitAction === "email" && form.submitEmail) {
      console.log(`[FORM] Email notification queued for ${form.submitEmail} (form: ${form.slug}, submission: ${submission.id})`);
    }

    res.status(201).json({
      success: true,
      submissionId: submission.id,
      message: form.successMessage || "Thank you! Your submission has been received.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({
      error: msg,
      message: formRecord?.errorMessage || "Something went wrong. Please try again later.",
    });
  }
});

router.get("/website/seo-overview", ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
  try {
    const pages = await db.select({
      id: websitePagesTable.id,
      title: websitePagesTable.title,
      slug: websitePagesTable.slug,
      status: websitePagesTable.status,
      metaTitle: websitePagesTable.metaTitle,
      metaDescription: websitePagesTable.metaDescription,
      ogImageUrl: websitePagesTable.ogImageUrl,
      canonicalUrl: websitePagesTable.canonicalUrl,
      robotsIndex: websitePagesTable.robotsIndex,
      robotsFollow: websitePagesTable.robotsFollow,
      ogTitle: websitePagesTable.ogTitle,
      ogDescription: websitePagesTable.ogDescription,
      twitterTitle: websitePagesTable.twitterTitle,
      twitterDescription: websitePagesTable.twitterDescription,
      twitterImageUrl: websitePagesTable.twitterImageUrl,
    }).from(websitePagesTable).orderBy(asc(websitePagesTable.sortOrder));
    res.json(pages);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/pages/:id/seo", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [page] = await db.select({
      slug: websitePagesTable.slug,
      metaTitle: websitePagesTable.metaTitle,
      metaDescription: websitePagesTable.metaDescription,
      canonicalUrl: websitePagesTable.canonicalUrl,
      robotsIndex: websitePagesTable.robotsIndex,
      robotsFollow: websitePagesTable.robotsFollow,
      ogTitle: websitePagesTable.ogTitle,
      ogDescription: websitePagesTable.ogDescription,
      ogImageUrl: websitePagesTable.ogImageUrl,
      twitterTitle: websitePagesTable.twitterTitle,
      twitterDescription: websitePagesTable.twitterDescription,
      twitterImageUrl: websitePagesTable.twitterImageUrl,
    }).from(websitePagesTable).where(eq(websitePagesTable.id, Number(req.params.id)));
    if (!page) return void res.status(404).json({ error: "Page not found" });
    res.json(page);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.put("/website/pages/:id/seo", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const allowedFields = [
      "metaTitle", "metaDescription", "ogImageUrl", "canonicalUrl",
      "robotsIndex", "robotsFollow", "ogTitle", "ogDescription",
      "twitterTitle", "twitterDescription", "twitterImageUrl", "slug",
    ];
    const updates: Record<string, unknown> = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const [page] = await db.update(websitePagesTable)
      .set(updates)
      .where(eq(websitePagesTable.id, Number(req.params.id)))
      .returning();
    if (!page) return void res.status(404).json({ error: "Not found" });
    res.json(page);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

async function resolveAiIntegration(): Promise<{ provider: "openai" | "anthropic"; apiKey: string; model?: string } | null> {
  const integrations = await db.select().from(integrationsTable)
    .where(inArray(integrationsTable.key, ["openai", "claude"]));
  for (const integ of integrations) {
    if (!integ.isEnabled) continue;
    const config = integ.config as Record<string, string>;
    if (!config?.apiKey) continue;
    return {
      provider: integ.key === "openai" ? "openai" : "anthropic",
      apiKey: config.apiKey,
      model: config.model || undefined,
    };
  }
  return null;
}

router.post("/website/ai/generate", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const aiConfig = await resolveAiIntegration();
    if (!aiConfig) {
      return void res.status(400).json({ error: "AI not configured. Enable OpenAI or Anthropic Claude in Settings > Integrations." });
    }

    const { action, context, locale } = req.body;
    if (!action) return void res.status(400).json({ error: "action is required" });

    const { AiContentService } = await import("../lib/aiService");
    const aiService = new AiContentService(aiConfig);

    const result = await aiService.generate({ action, context, locale });
    res.json({ result, action });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/ai/status", ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
  try {
    const aiConfig = await resolveAiIntegration();
    res.json({ configured: !!aiConfig, provider: aiConfig?.provider || null });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.get("/website/translations/status", ...adminOnly, async (_req: Request, res: Response): Promise<void> => {
  try {
    const [settings] = await db.select({ supportedLanguages: settingsTable.supportedLanguages }).from(settingsTable);
    const locales = (settings?.supportedLanguages || "en").split(",").map((l: string) => l.trim());

    const pages = await db.select({
      id: websitePagesTable.id,
      title: websitePagesTable.title,
      slug: websitePagesTable.slug,
      locale: websitePagesTable.locale,
      metaTitle: websitePagesTable.metaTitle,
      metaDescription: websitePagesTable.metaDescription,
      ogTitle: websitePagesTable.ogTitle,
      ogDescription: websitePagesTable.ogDescription,
      twitterTitle: websitePagesTable.twitterTitle,
      twitterDescription: websitePagesTable.twitterDescription,
      translationsJson: websitePagesTable.translationsJson,
    }).from(websitePagesTable).orderBy(asc(websitePagesTable.sortOrder));

    const posts = await db.select({
      id: websiteBlogPostsTable.id,
      title: websiteBlogPostsTable.title,
      slug: websiteBlogPostsTable.slug,
      locale: websiteBlogPostsTable.locale,
      excerpt: websiteBlogPostsTable.excerpt,
      metaTitle: websiteBlogPostsTable.metaTitle,
      metaDescription: websiteBlogPostsTable.metaDescription,
      translationsJson: websiteBlogPostsTable.translationsJson,
    }).from(websiteBlogPostsTable).orderBy(desc(websiteBlogPostsTable.createdAt));

    res.json({ locales, pages, posts });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.put("/website/pages/:id/translations", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [page] = await db.update(websitePagesTable)
      .set({ translationsJson: req.body.translations || {} })
      .where(eq(websitePagesTable.id, Number(req.params.id)))
      .returning();
    if (!page) return void res.status(404).json({ error: "Not found" });
    res.json(page);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

router.put("/website/blog-posts/:id/translations", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const [post] = await db.update(websiteBlogPostsTable)
      .set({ translationsJson: req.body.translations || {} })
      .where(eq(websiteBlogPostsTable.id, Number(req.params.id)))
      .returning();
    if (!post) return void res.status(404).json({ error: "Not found" });
    res.json(post);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    res.status(500).json({ error: msg });
  }
});

export default router;
