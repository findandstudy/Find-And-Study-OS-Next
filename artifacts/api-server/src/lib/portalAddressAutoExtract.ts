import { and, eq, isNull, or } from "drizzle-orm";
import { db, studentsTable } from "@workspace/db";
import { logAudit } from "./auth.js";
import { documentAiScheduler } from "./aiLaneScheduler.js";
import { getDocumentAiConnection } from "./documentAiConnection.js";

export interface PortalAddressAutoExtractResult {
  status:
    | "updated"
    | "no_missing_city"
    | "no_address"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
  source?: "deterministic" | "ai";
}

interface AddressCityExtraction {
  city?: unknown;
  evidence?: unknown;
  confidence?: unknown;
}

const ADDRESS_TOKEN_RE =
  /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|house|plot|apartment|apt\.?|building|floor|block|village|district|province|region|state|mahallesi|mahalle|sokak|cadde|caddesi)\b/iu;

const PROMPT = `Extract the residence city from an existing university applicant address.
Return ONLY one JSON object:
{
  "city": "city name or null",
  "evidence": "the exact contiguous address text proving the city or null",
  "confidence": "high|medium|low"
}
Rules:
- Never guess and never use outside knowledge to invent a city.
- Use only the supplied address text.
- A country, province, state, district, street, village, or postal code is not a city.
- "evidence" must be copied exactly from the supplied address.
- Use confidence=high only when the address explicitly and unambiguously names the city.
- Otherwise return city=null and confidence=low.`;

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanCityCandidate(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^[,.;:/\s]+|[,.;:/\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+city$/iu, "")
    .trim();
  if (
    text.length < 2 ||
    text.length > 80 ||
    /\d/u.test(text) ||
    !/\p{L}/u.test(text) ||
    ADDRESS_TOKEN_RE.test(text) ||
    text.split(/\s+/).length > 5
  ) {
    return null;
  }
  return text;
}

function differsFromNationality(
  candidate: string,
  nationality: string | null | undefined,
): boolean {
  const nation = fold(nationality ?? "");
  return !nation || fold(candidate) !== nation;
}

/**
 * Only resolves shapes that are self-proving without a model:
 * - "KHIRDALAN CITY" in an address segment
 * - a single bare city token such as "GUJRAT"
 */
export function deriveDeterministicAddressCity(
  address: string,
  nationality?: string | null,
): string | null {
  const raw = address.trim();
  if (!raw) return null;
  const segments = raw
    .split(/[,\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (!/\bcity\s*$/iu.test(segment)) continue;
    const candidate = cleanCityCandidate(segment);
    if (candidate && differsFromNationality(candidate, nationality)) {
      return candidate;
    }
  }

  if (segments.length === 1) {
    const candidate = cleanCityCandidate(segments[0]);
    if (
      candidate &&
      candidate.split(/\s+/).length <= 2 &&
      differsFromNationality(candidate, nationality)
    ) {
      return candidate;
    }
  }

  return null;
}

export function parseAddressCityExtraction(
  address: string,
  nationality: string | null | undefined,
  extracted: AddressCityExtraction,
): string | null {
  if (String(extracted.confidence ?? "").toLowerCase() !== "high") {
    return null;
  }
  const candidate = cleanCityCandidate(extracted.city);
  const evidence = String(extracted.evidence ?? "").trim();
  if (!candidate || !evidence || !differsFromNationality(candidate, nationality)) {
    return null;
  }

  const foldedAddress = fold(address);
  const foldedEvidence = fold(evidence);
  const foldedCandidate = fold(candidate);
  if (
    !foldedEvidence ||
    !foldedAddress.includes(foldedEvidence) ||
    !foldedEvidence.includes(foldedCandidate)
  ) {
    return null;
  }
  return candidate;
}

async function persistMissingCity(
  studentId: number,
  city: string,
): Promise<boolean> {
  const updated = await db
    .update(studentsTable)
    .set({ addressCity: city })
    .where(and(
      eq(studentsTable.id, studentId),
      isNull(studentsTable.deletedAt),
      or(
        isNull(studentsTable.addressCity),
        eq(studentsTable.addressCity, ""),
      ),
    ))
    .returning({ id: studentsTable.id });
  return updated.length > 0;
}

export async function autoFillMissingAddressCity(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
  requiredFields?: readonly string[];
}): Promise<PortalAddressAutoExtractResult> {
  if (
    opts.requiredFields &&
    !opts.requiredFields.includes("addressCity")
  ) {
    return { status: "no_missing_city", fields: [] };
  }

  const [student] = await db
    .select({
      address: studentsTable.address,
      addressCity: studentsTable.addressCity,
      nationality: studentsTable.nationality,
    })
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) return { status: "unreadable", fields: [] };
  if (student.addressCity?.trim()) {
    return { status: "no_missing_city", fields: [] };
  }

  const address = student.address?.trim() ?? "";
  if (!address) return { status: "no_address", fields: [] };

  let city = deriveDeterministicAddressCity(address, student.nationality);
  let source: "deterministic" | "ai" = "deterministic";

  if (!city) {
    source = "ai";
    try {
      const connection = await getDocumentAiConnection("claude", { fallbackToDefault: false });
      const anthropic = connection.client;
      const config = { model: connection.model };
      const message = await documentAiScheduler.run(
        { laneKey: "portal-data-extraction", connectionKey: "claude" },
        () => anthropic.messages.create({
          model: config.model || "claude-sonnet-4-6",
          max_tokens: 512,
          messages: [{
            role: "user",
            content:
              `${PROMPT}\n\nInput:\n${JSON.stringify({
                address,
                nationality: student.nationality ?? null,
              })}`,
          }],
        }),
      );
      const block = message.content.find((item) => item.type === "text");
      const json = block?.type === "text"
        ? block.text.match(/\{[\s\S]*\}/)?.[0]
        : null;
      if (!json) return { status: "unreadable", fields: [], source };
      city = parseAddressCityExtraction(
        address,
        student.nationality,
        JSON.parse(json) as AddressCityExtraction,
      );
    } catch {
      return { status: "ai_unavailable", fields: [], source };
    }
  }

  if (!city) return { status: "low_confidence", fields: [], source };
  const persisted = await persistMissingCity(opts.studentId, city);
  if (!persisted) {
    return { status: "no_missing_city", fields: [], source };
  }

  await logAudit(
    opts.actorUserId,
    "portal_preflight_auto_fill_address_city",
    "student",
    opts.studentId,
    { fields: ["addressCity"], confidence: "high", source },
    opts.ip,
  );
  return { status: "updated", fields: ["addressCity"], source };
}
