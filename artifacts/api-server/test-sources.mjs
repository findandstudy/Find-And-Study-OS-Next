import { db, leadsTable, embedWidgetsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
const [leadRows, widgetRows] = await Promise.all([
  db.selectDistinct({ source: leadsTable.source }).from(leadsTable).where(sql`${leadsTable.source} IS NOT NULL AND ${leadsTable.source} != ''`),
  db.select({ slug: embedWidgetsTable.slug, name: embedWidgetsTable.name, mode: embedWidgetsTable.mode }).from(embedWidgetsTable),
]);
const byValue = new Map();
for (const w of widgetRows) {
  if (!w.slug) continue;
  const value = `embed:${w.slug}`;
  const isLeadForm = w.mode === "lead_form";
  byValue.set(value, { value, label: `${isLeadForm?"Web Form":"Embed"}: ${w.name||w.slug}`, kind: isLeadForm?"lead_form":"embed" });
}
for (const r of leadRows) {
  const v = r.source;
  if (!v || byValue.has(v)) continue;
  byValue.set(v, { value: v, label: v, kind: "other" });
}
const order = { lead_form: 0, embed: 1, other: 2 };
const data = [...byValue.values()].sort((a,b) => (order[a.kind]-order[b.kind]) || a.label.localeCompare(b.label,"tr"));
console.log(JSON.stringify({data}, null, 2));
process.exit(0);
