import type { CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { InboxPipelineStageSummary } from "@workspace/api-client-react";

interface PipelineStageBadgeProps {
  stage: InboxPipelineStageSummary | null | undefined;
  size?: "sm" | "md";
  className?: string;
}

function variantClasses(variant: string | null | undefined): string {
  switch (variant) {
    case "success":
      return "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60";
    case "warning":
      return "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60";
    case "destructive":
      return "bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60";
    case "info":
      return "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60";
    default:
      return "bg-secondary text-secondary-foreground border-transparent";
  }
}

export function PipelineStageBadge({ stage, size = "sm", className }: PipelineStageBadgeProps) {
  if (!stage) return null;

  const inlineStyle: CSSProperties | undefined = stage.color
    ? {
        backgroundColor: `${stage.color}1f`,
        color: stage.color,
        borderColor: `${stage.color}59`,
      }
    : undefined;

  const variantClass = stage.color ? "" : variantClasses(stage.variant);
  const sizeClass = size === "sm" ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-1";

  return (
    <Badge
      variant="outline"
      className={cn("font-medium border", variantClass, sizeClass, className)}
      style={inlineStyle}
      data-testid="pipeline-stage-badge"
    >
      {stage.label}
      {/* TODO Faz 4.2: render stage.icon (Lucide name) before label */}
    </Badge>
  );
}
