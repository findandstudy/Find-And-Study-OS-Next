import { useState } from "react";
import { useGetStudentPortalReadiness } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";

/**
 * Portal Uyumluluk Katmanı Faz 3 — soft readiness badge.
 * Display-only: never blocks any action. Shows "Ready for SIT" or the
 * missing/incompatible field list in a popover.
 */
export function PortalReadinessBadge({ studentId, portal = "sit" }: { studentId: number; portal?: string }) {
  const { t, dir } = useI18n() as any;
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGetStudentPortalReadiness(studentId, { portal }) as {
    data: {
      applicable?: boolean;
      supported?: boolean;
      ready: boolean;
      missing: string[];
      incompatible: { field: string; reason: string }[];
    } | undefined;
    isLoading: boolean;
  };

  if (isLoading || !data || data.applicable === false || data.supported === false) return null;

  const fieldLabel = (key: string) => {
    const label = t(`portalReadiness.fields.${key}`);
    return label && !label.startsWith("portalReadiness.") ? label : key;
  };

  if (data.ready) {
    return (
      <Badge
        className="px-3 py-1 rounded-full text-sm font-medium border-0 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 flex items-center gap-1"
        data-testid="portal-readiness-badge"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        {t("portalReadiness.ready", { portal: portal.toUpperCase() })}
      </Badge>
    );
  }

  const issueCount = data.missing.length + data.incompatible.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid="portal-readiness-badge">
          <Badge className="px-3 py-1 rounded-full text-sm font-medium border-0 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 flex items-center gap-1 cursor-pointer">
            <AlertTriangle className="w-3.5 h-3.5" />
            {t("portalReadiness.notReady", { portal: portal.toUpperCase(), count: issueCount })}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-sm" dir={dir}>
        {data.missing.length > 0 && (
          <div className="mb-2">
            <p className="font-medium mb-1">{t("portalReadiness.missingFields")}</p>
            <ul className="list-disc ps-4 space-y-0.5 text-muted-foreground">
              {data.missing.map((f) => <li key={f}>{fieldLabel(f)}</li>)}
            </ul>
          </div>
        )}
        {data.incompatible.length > 0 && (
          <div className="mb-2">
            <p className="font-medium mb-1">{t("portalReadiness.incompatible")}</p>
            <ul className="list-disc ps-4 space-y-0.5 text-muted-foreground">
              {data.incompatible.map((i) => (
                <li key={i.field}>
                  {fieldLabel(i.field)} — {t(`portalReadiness.reasons.${i.reason}`)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("portalReadiness.softNote")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** Compact inline warning for list rows (Submission Board). Renders nothing when ready. */
export function PortalReadinessInlineWarning({ studentId, portal = "sit" }: { studentId: number; portal?: string }) {
  const { t } = useI18n() as any;
  const { data } = useGetStudentPortalReadiness(studentId, { portal }) as {
    data: {
      applicable?: boolean;
      supported?: boolean;
      ready: boolean;
      missing: string[];
      incompatible: { field: string; reason: string }[];
    } | undefined;
  };
  if (!data || data.applicable === false || data.supported === false || data.ready) return null;
  const count = data.missing.length + data.incompatible.length;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
      data-testid="portal-readiness-inline-warning"
      title={[...data.missing, ...data.incompatible.map((i) => i.field)].join(", ")}
    >
      <AlertTriangle className="w-3 h-3 shrink-0" />
      {t("portalReadiness.notReady", { portal: portal.toUpperCase(), count })}
    </span>
  );
}
