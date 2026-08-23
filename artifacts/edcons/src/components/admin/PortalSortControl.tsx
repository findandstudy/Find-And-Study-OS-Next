import { useI18n } from "@/hooks/use-i18n";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type PortalSortDir = "asc" | "desc";

/** Small toolbar sort control shared by Portal Automation admin tabs whose
 *  lists render as Card/div rows (not native tables), so column-header
 *  sorting isn't available — sort lives at the toolbar level instead. */
export function PortalSortControl<F extends string>({
  field, dir, options, onFieldChange, onToggleDir,
}: {
  field: F;
  dir: PortalSortDir;
  options: { value: F; label: string }[];
  onFieldChange: (f: F) => void;
  onToggleDir: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <Select value={field} onValueChange={(v) => onFieldChange(v as F)}>
        <SelectTrigger className="w-40 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon"
        className="w-8 h-8 shrink-0"
        onClick={onToggleDir}
        aria-label={t("portalAutomation.sort.toggleDir")}
        title={dir === "asc" ? t("portalAutomation.sort.asc") : t("portalAutomation.sort.desc")}
      >
        <ArrowUpDown className={cn("w-3.5 h-3.5", dir === "desc" && "scale-y-[-1]")} />
      </Button>
    </div>
  );
}
