import { ExternalLink } from "lucide-react";

type Props = {
  subjectType?: string | null;
  subjectId?: number | null;
  subjectLabel?: string | null;
  className?: string;
};

const SUBJECT_LABELS: Record<string, string> = {
  agent: "Agent",
  student: "Student",
  lead: "Lead",
  application: "Application",
  university: "University",
  company: "Company",
  other: "Other",
};

function associationHref(subjectType?: string | null, subjectId?: number | null): string | null {
  if (!subjectType || !subjectId) return null;
  switch (subjectType) {
    case "agent": return `/staff/agents/${subjectId}`;
    case "student": return `/staff/students/${subjectId}`;
    case "lead": return `/staff/leads/${subjectId}`;
    case "application": return `/staff/applications/${subjectId}`;
    case "company": return `/admin/company-contracts/${subjectId}`;
    // There is currently no canonical university entity-detail route. Linking
    // to /admin/university-contracts/:id would be incorrect because that route
    // expects a university-contract record id, not a university id.
    default: return null;
  }
}

export function ContractAssociationLink({ subjectType, subjectId, subjectLabel, className = "" }: Props) {
  if (!subjectType) return <span className={`text-muted-foreground ${className}`}>—</span>;

  const typeLabel = SUBJECT_LABELS[subjectType] || subjectType;
  const fallback = `${typeLabel}${subjectId ? ` #${subjectId}` : ""}`;
  const displayLabel = subjectLabel?.trim() || fallback;
  const href = associationHref(subjectType, subjectId);

  return (
    <div className={`min-w-0 ${className}`}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 font-medium text-primary hover:underline"
          title={`Open ${displayLabel}`}
        >
          <span className="truncate">{displayLabel}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <div className="truncate font-medium" title={displayLabel}>{displayLabel}</div>
      )}
      <div className="text-[11px] capitalize text-muted-foreground">
        {typeLabel}{subjectId ? ` #${subjectId}` : ""}
      </div>
    </div>
  );
}
