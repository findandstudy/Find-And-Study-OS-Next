import { Router, type IRouter, type Request, type Response } from "express";
import { db, destinationsTable, universitiesTable, programsTable } from "@workspace/db";
import { eq, and, sql, asc, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/public/destinations", async (_req: Request, res: Response): Promise<void> => {
  const destinations = await db.select()
    .from(destinationsTable)
    .where(eq(destinationsTable.isActive, true))
    .orderBy(asc(destinationsTable.sortOrder), asc(destinationsTable.name));

  const countryCounts = await db.select({
    countryKey: sql<string>`lower(trim(${universitiesTable.country}))`.as("country_key"),
    uniCount: sql<number>`count(DISTINCT ${universitiesTable.id})`.as("uni_count"),
    progCount: sql<number>`count(DISTINCT ${programsTable.id})`.as("prog_count"),
  })
    .from(universitiesTable)
    .leftJoin(programsTable, and(
      eq(programsTable.universityId, universitiesTable.id),
      eq(programsTable.isActive, true),
    ))
    .where(eq(universitiesTable.isActive, true))
    .groupBy(sql`lower(trim(${universitiesTable.country}))`);

  const countMap = new Map(countryCounts.map(c => [c.countryKey, { uniCount: Number(c.uniCount), progCount: Number(c.progCount) }]));

  const enriched = destinations.map(d => {
    const key = (d.country ?? "").trim().toLowerCase();
    const live = countMap.get(key);
    return {
      ...d,
      universityCount: live?.uniCount ?? 0,
      programCount: live?.progCount ?? 0,
    };
  });

  res.json(enriched);
});

router.get("/public/destinations/:slug", async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);

  const [destination] = await db.select()
    .from(destinationsTable)
    .where(and(eq(destinationsTable.slug, slug), eq(destinationsTable.isActive, true)))
    .limit(1);

  if (!destination) {
    res.status(404).json({ error: "Destination not found" });
    return;
  }

  const universities = await db.select({
    id: universitiesTable.id,
    name: universitiesTable.name,
    city: universitiesTable.city,
    logoUrl: universitiesTable.logoUrl,
    ranking: universitiesTable.ranking,
    universityType: universitiesTable.universityType,
  })
    .from(universitiesTable)
    .where(and(
      sql`lower(trim(${universitiesTable.country})) = lower(trim(${destination.country}))`,
      eq(universitiesTable.isActive, true),
    ))
    .orderBy(asc(universitiesTable.name));

  const uniIds = universities.map(u => u.id);

  let programs: any[] = [];
  if (uniIds.length > 0) {
    programs = await db.select({
      id: programsTable.id,
      name: programsTable.name,
      degree: programsTable.degree,
      language: programsTable.language,
      duration: programsTable.duration,
      tuitionFee: programsTable.tuitionFee,
      currency: programsTable.currency,
      discountedFee: programsTable.discountedFee,
      universityId: programsTable.universityId,
    })
      .from(programsTable)
      .where(and(
        sql`${programsTable.universityId} IN ${uniIds.length > 0 ? sql`(${sql.join(uniIds.map(id => sql`${id}`), sql`,`)})` : sql`(-1)`}`,
        eq(programsTable.isActive, true),
      ))
      .orderBy(asc(programsTable.name))
      .limit(50);
  }

  const stats = {
    universityCount: universities.length,
    programCount: programs.length,
  };

  res.json({ destination, universities, programs, stats });
});

export default router;
