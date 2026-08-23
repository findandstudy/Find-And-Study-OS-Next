import { ArrowDown, ArrowUp, RotateCcw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/hooks/use-i18n";

export interface ColumnSettingsItem {
  id: string;
  label: string;
}

export interface ColumnSettingsMenuProps {
  columns: ColumnSettingsItem[];
  order: string[];
  hidden: string[];
  onToggle: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onReset: () => void;
  triggerLabel?: string;
  title?: string;
  /**
   * IDs of columns that must always remain visible — the show/hide
   * checkbox is disabled for these, so admins can't accidentally hide
   * mandatory action columns (Task #167).
   */
  alwaysVisibleIds?: string[];
}

export function ColumnSettingsMenu({
  columns,
  order,
  hidden,
  onToggle,
  onMove,
  onReset,
  triggerLabel,
  title,
  alwaysVisibleIds = [],
}: ColumnSettingsMenuProps) {
  const { t } = useI18n();
  const resolvedTriggerLabel = triggerLabel ?? t("columnSettings.columns");
  const resolvedTitle = title ?? t("columnSettings.title");
  const labelOf = (id: string) => columns.find((c) => c.id === id)?.label || id;
  const alwaysVisible = new Set(alwaysVisibleIds);
  const visibleCount = order.filter((id) => alwaysVisible.has(id) || !hidden.includes(id)).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5">
          <Settings2 className="w-3.5 h-3.5" />
          <span>{resolvedTriggerLabel}</span>
          <span className="text-xs text-muted-foreground">
            ({visibleCount}/{order.length})
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-sm font-semibold">{resolvedTitle}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={onReset}
            title={t("columnSettings.resetTooltip")}
          >
            <RotateCcw className="h-3 w-3" /> {t("columnSettings.reset")}
          </Button>
        </div>
        <p className="px-2 pb-2 text-[11px] text-muted-foreground leading-snug">
          {t("columnSettings.hint")}
        </p>
        <div className="max-h-80 overflow-auto pr-1">
          {order.map((id, idx) => {
            const locked = alwaysVisible.has(id);
            const isHidden = !locked && hidden.includes(id);
            return (
              <div
                key={id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50"
              >
                <Checkbox
                  id={`col-${id}`}
                  checked={!isHidden}
                  disabled={locked}
                  onCheckedChange={() => { if (!locked) onToggle(id); }}
                />
                <label
                  htmlFor={`col-${id}`}
                  className={`flex-1 text-sm select-none truncate flex items-center gap-1.5 ${locked ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"}`}
                  title={locked ? t("columnSettings.alwaysVisible") : undefined}
                >
                  <span className="truncate">{labelOf(id)}</span>
                  {locked && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border border-border/70">
                      {t("columnSettings.alwaysVisible")}
                    </span>
                  )}
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={idx === 0}
                  onClick={() => onMove(id, -1)}
                  title={t("columnSettings.moveUp")}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={idx === order.length - 1}
                  onClick={() => onMove(id, 1)}
                  title={t("columnSettings.moveDown")}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
