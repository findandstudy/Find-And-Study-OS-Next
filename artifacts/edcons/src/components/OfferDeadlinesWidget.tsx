import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AlertTriangle, Calendar, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const STAGE_LABELS: Record<string, string> = {
  offer_received: "Offer",
  acceptance_letter: "Acceptance Letter",
  final_acceptance: "Final Acceptance",
};

interface DeadlineRow {
  docId: number;
  applicationId: number;
  stage: string;
  fileName: string;
  validUntil: string | null;
  daysLeft: number | null;
  studentFirstName?: string | null;
  studentLastName?: string | null;
  universityName?: string | null;
  programName?: string | null;
}

interface Props {
  /** Detail link prefix per portal (e.g. "/staff/applications", "/agent/apps", "/student/applications") */
  detailHrefPrefix: string;
  /** Hide the student column (e.g. on student dashboard where it's redundant) */
  hideStudent?: boolean;
}

export function OfferDeadlinesWidget({ detailHrefPrefix, hideStudent }: Props) {
  const { data, isLoading } = useQuery<{ data: DeadlineRow[] }>({
    queryKey: ["offer-letter-deadlines"],
    queryFn: () => customFetch(`${BASE_URL}/api/applications/offer-letter-deadlines`),
    staleTime: 60_000,
  });

  const rows = data?.data || [];

  function urgencyClass(days: number | null): string {
    if (days === null) return "bg-secondary text-foreground";
    if (days <= 0) return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    if (days <= 7) return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    if (days <= 14) return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
    if (days <= 30) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300";
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
  }

  return (
    <div className="bg-card rounded-2xl border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
        </div>
        <div>
          <h3 className="font-semibold text-foreground">Offer Letter Deadlines</h3>
          <p className="text-xs text-muted-foreground">Upcoming expiry dates</p>
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No upcoming offer letter deadlines.</p>
      ) : (
        <div className="space-y-2 max-h-[320px] overflow-y-auto">
          {rows.map(r => {
            const validUntilDate = r.validUntil ? new Date(r.validUntil) : null;
            const studentName = `${r.studentFirstName || ""} ${r.studentLastName || ""}`.trim();
            return (
              <Link key={r.docId} href={`${detailHrefPrefix}/${r.applicationId}`}>
                <a className="block p-2.5 rounded-xl hover:bg-secondary/50 transition-colors group">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">
                        {r.universityName || "University"}
                        {r.programName ? ` · ${r.programName}` : ""}
                      </p>
                      {!hideStudent && studentName && (
                        <p className="text-xs text-muted-foreground truncate">{studentName}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {STAGE_LABELS[r.stage] || r.stage}
                        </Badge>
                        {validUntilDate && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {`${String(validUntilDate.getDate()).padStart(2,"0")}.${String(validUntilDate.getMonth()+1).padStart(2,"0")}.${validUntilDate.getFullYear()}`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <Badge className={`text-[10px] px-1.5 py-0 border-0 ${urgencyClass(r.daysLeft)}`}>
                        {r.daysLeft === null ? "—" : r.daysLeft <= 0 ? "Expired" : `${r.daysLeft} days`}
                      </Badge>
                      <ChevronRight className="w-3 h-3 text-muted-foreground mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                </a>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
