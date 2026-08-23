import { Home, Briefcase, Users } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type OriginType = "direct" | "agent" | "sub_agent";

const ORIGIN_CONFIG: Record<OriginType, { icon: typeof Home; color: string; label: string }> = {
  direct: {
    icon: Home,
    color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
    label: "Direct",
  },
  agent: {
    icon: Briefcase,
    color: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60",
    label: "Agent",
  },
  sub_agent: {
    icon: Users,
    color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
    label: "Sub-Agent",
  },
};

export interface OriginBadgeProps {
  originType?: string | null;
  originDisplayName?: string | null;
  size?: "sm" | "md";
  className?: string;
}

export function OriginBadge({ originType, originDisplayName, size = "sm" }: OriginBadgeProps) {
  if (!originType) return null;

  const config = ORIGIN_CONFIG[originType as OriginType];
  if (!config) return null;

  const Icon = config.icon;
  const displayText = originType === "direct"
    ? config.label
    : originDisplayName
      ? `${config.label} · ${originDisplayName}`
      : config.label;

  const isSm = size === "sm";

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 rounded-full border font-medium truncate ${config.color} ${
              isSm ? "text-[10px] px-1.5 py-0.5 max-w-[140px]" : "text-xs px-2 py-0.5 max-w-[180px]"
            }`}
          >
            <Icon className={isSm ? "w-3 h-3 shrink-0" : "w-3.5 h-3.5 shrink-0"} />
            <span className="truncate">{displayText}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {displayText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function OriginSection({
  originType,
  originDisplayName,
  originLeadId,
  originStudentId,
}: {
  originType?: string | null;
  originDisplayName?: string | null;
  originLeadId?: number | null;
  originStudentId?: number | null;
}) {
  if (!originType) return null;

  const config = ORIGIN_CONFIG[originType as OriginType];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border font-medium px-2.5 py-1 text-xs ${config.color}`}>
          <Icon className="w-3.5 h-3.5" />
          {config.label}
        </span>
        {originDisplayName && originType !== "direct" && (
          <span className="text-sm text-muted-foreground">{originDisplayName}</span>
        )}
      </div>
      {originLeadId && (
        <p className="text-xs text-muted-foreground">Converted from Lead #{originLeadId}</p>
      )}
      {originStudentId && (
        <p className="text-xs text-muted-foreground">Inherited from Student #{originStudentId}</p>
      )}
    </div>
  );
}

