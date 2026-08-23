import { Router, type IRouter } from "express";
import { db, leadsTable, studentsTable, applicationsTable, agentsTable, commissionsTable, universitiesTable, usersTable, followUpsTable, programsTable } from "@workspace/db";
import { eq, sql, and, desc, inArray, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import * as XLSX from "xlsx";

const router: IRouter = Router();

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Parse a comma-separated `ids` query param into a list of numeric ids. When a
// selection is present the export is narrowed to exactly those rows; when empty
// the caller exports the full (season-filtered) set.
function parseIds(req: any): number[] {
  const raw = (req.query?.ids as string) || "";
  if (!raw) return [];
  return raw.split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => Number.isFinite(n));
}

function sendExcel(res: any, data: Record<string, any>[], filename: string, sheetName: string) {
  const ws = XLSX.utils.json_to_sheet(data);
  const colWidths = Object.keys(data[0] || {}).map(key => {
    const maxLen = Math.max(
      key.length,
      ...data.map(row => String(row[key] ?? "").length)
    );
    return { wch: Math.min(maxLen + 2, 40) };
  });
  ws["!cols"] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

router.get("/export/leads", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions: any[] = [isNull(leadsTable.deletedAt)];
  if (season) conditions.push(eq(leadsTable.season, season));
  const ids = parseIds(req);
  if (ids.length > 0) conditions.push(inArray(leadsTable.id, ids));

  const rows = await db
    .select({
      lead: leadsTable,
      agentName: agentsTable.companyName,
      assignedFirstName: usersTable.firstName,
      assignedLastName: usersTable.lastName,
    })
    .from(leadsTable)
    .leftJoin(agentsTable, eq(leadsTable.agentId, agentsTable.id))
    .leftJoin(usersTable, eq(leadsTable.assignedToId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(leadsTable.createdAt));

  const leadIds = rows.map(r => r.lead.id);
  let nextFollowupMap = new Map<number, string>();
  if (leadIds.length > 0) {
    const fuRows = await db
      .select({
        leadId: followUpsTable.leadId,
        nextDate: sql<string>`min(${followUpsTable.scheduledAt})`,
      })
      .from(followUpsTable)
      .where(and(
        inArray(followUpsTable.leadId, leadIds),
        eq(followUpsTable.completed, false),
      ))
      .groupBy(followUpsTable.leadId);
    fuRows.forEach(r => { if (r.leadId) nextFollowupMap.set(r.leadId, r.nextDate); });
  }

  const data = rows.map(r => ({
    "ID": r.lead.id,
    "First Name": r.lead.firstName || "",
    "Last Name": r.lead.lastName || "",
    "Email": r.lead.email || "",
    "Phone": r.lead.phone || "",
    "Nationality": r.lead.nationality || "",
    "Country": r.lead.country || "",
    "Status": r.lead.status || "",
    "Source": r.lead.source || "",
    "Interested Program": r.lead.interestedProgram || "",
    "Interested University": r.lead.interestedUniversity || "",
    "Interested Country": r.lead.interestedCountry || "",
    "Estimated Value": r.lead.estimatedValue ?? "",
    "Agent": r.agentName || "",
    "Assigned To": [r.assignedFirstName, r.assignedLastName].filter(Boolean).join(" ") || "",
    "Season": r.lead.season || "",
    "Next Follow-up": nextFollowupMap.get(r.lead.id) ? formatDate(nextFollowupMap.get(r.lead.id)) : "",
    "Notes": r.lead.notes || "",
    "Created": formatDate(r.lead.createdAt),
    "Updated": formatDate(r.lead.updatedAt),
  }));

  sendExcel(res, data.length > 0 ? data : [{ "No Data": "No leads found" }], `leads_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Leads");
});

router.get("/export/students", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions: any[] = [isNull(studentsTable.deletedAt)];
  if (season) conditions.push(eq(studentsTable.season, season));
  const ids = parseIds(req);
  if (ids.length > 0) conditions.push(inArray(studentsTable.id, ids));

  const rows = await db
    .select({
      student: studentsTable,
      agentName: agentsTable.companyName,
      assignedFirstName: usersTable.firstName,
      assignedLastName: usersTable.lastName,
    })
    .from(studentsTable)
    .leftJoin(agentsTable, eq(studentsTable.agentId, agentsTable.id))
    .leftJoin(usersTable, eq(studentsTable.assignedToId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(studentsTable.createdAt));

  const data = rows.map(r => ({
    "ID": r.student.id,
    "First Name": r.student.firstName || "",
    "Last Name": r.student.lastName || "",
    "Email": r.student.email || "",
    "Phone": r.student.phone || "",
    "Date of Birth": r.student.dateOfBirth || "",
    "Nationality": r.student.nationality || "",
    "Passport Number": r.student.passportNumber || "",
    "Passport Issue Date": r.student.passportIssueDate || "",
    "Passport Expiry": r.student.passportExpiry || "",
    "Mother Name": r.student.motherName || "",
    "Father Name": r.student.fatherName || "",
    "Address": r.student.address || "",
    "Status": r.student.status || "",
    "High School": r.student.highSchool || "",
    "University (Bachelor)": r.student.universityBachelor || "",
    "University (Master)": r.student.universityMaster || "",
    "Graduation Year": r.student.graduationYear ?? "",
    "GPA": r.student.gpa || "",
    "Language Score": r.student.languageScore || "",
    "Agent": r.agentName || "",
    "Assigned To": [r.assignedFirstName, r.assignedLastName].filter(Boolean).join(" ") || "",
    "Season": r.student.season || "",
    "Notes": r.student.notes || "",
    "Created": formatDate(r.student.createdAt),
    "Updated": formatDate(r.student.updatedAt),
  }));

  sendExcel(res, data.length > 0 ? data : [{ "No Data": "No students found" }], `students_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Students");
});

router.get("/export/applications", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions: any[] = [isNull(applicationsTable.deletedAt)];
  if (season) conditions.push(eq(applicationsTable.season, season));
  const ids = parseIds(req);
  if (ids.length > 0) conditions.push(inArray(applicationsTable.id, ids));

  const rows = await db
    .select({
      app: applicationsTable,
      studentFirstName: studentsTable.firstName,
      studentLastName: studentsTable.lastName,
      studentEmail: studentsTable.email,
      studentPhone: studentsTable.phone,
      studentNationality: studentsTable.nationality,
      studentPassport: studentsTable.passportNumber,
      universityCommissionAmount: commissionsTable.universityCommissionAmount,
      commissionStatus: commissionsTable.status,
      universityType: universitiesTable.universityType,
      agentName: agentsTable.companyName,
      assignedFirstName: usersTable.firstName,
      assignedLastName: usersTable.lastName,
    })
    .from(applicationsTable)
    .leftJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
    .leftJoin(commissionsTable, eq(applicationsTable.id, commissionsTable.applicationId))
    .leftJoin(universitiesTable, eq(applicationsTable.universityId, universitiesTable.id))
    .leftJoin(agentsTable, eq(applicationsTable.agentId, agentsTable.id))
    .leftJoin(usersTable, eq(applicationsTable.assignedToId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(applicationsTable.createdAt));

  const data = rows.map(r => ({
    "ID": r.app.id,
    "Student": [r.studentFirstName, r.studentLastName].filter(Boolean).join(" ") || "",
    "Student Email": r.studentEmail || "",
    "Student Phone": r.studentPhone || "",
    "Student Nationality": r.studentNationality || "",
    "Passport": r.studentPassport || "",
    "Stage": r.app.stage || "",
    "University": r.app.universityName || "",
    "University Type": r.universityType || "",
    "Program": r.app.programName || "",
    "Country": r.app.country || "",
    "Level": r.app.level || "",
    "Intake": r.app.intake || "",
    "Instruction Language": r.app.instructionLanguage || "",
    "Deadline": r.app.deadline || "",
    "Tuition Fee": r.app.tuitionFee ?? "",
    "Discounted Fee": r.app.discountedFee ?? "",
    "Scholarship": r.app.scholarship ?? "",
    "Commission Rate (%)": r.app.commissionRate ?? "",
    "Commission Amount": r.universityCommissionAmount ?? "",
    "Commission Status": r.commissionStatus || "",
    "Service Fee": r.app.serviceFeeAmount ?? "",
    "Application Fee": r.app.applicationFee ?? "",
    "Deposit Fee": r.app.depositFee ?? "",
    "Advanced Fee": r.app.advancedFee ?? "",
    "Language Fee": r.app.languageFee ?? "",
    "Currency": r.app.currency || "",
    "Agent": r.agentName || "",
    "Assigned To": [r.assignedFirstName, r.assignedLastName].filter(Boolean).join(" ") || "",
    "Season": r.app.season || "",
    "Notes": r.app.notes || "",
    "Created": formatDate(r.app.createdAt),
    "Updated": formatDate(r.app.updatedAt),
  }));

  sendExcel(res, data.length > 0 ? data : [{ "No Data": "No applications found" }], `applications_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Applications");
});

export default router;
