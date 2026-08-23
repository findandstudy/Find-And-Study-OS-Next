/**
 * PortalTabStates.tsx — Shared empty / error / loading states for the
 * Portal Automation admin tabs. Keeps every tab visually consistent:
 *   - PortalEmptyState : icon + title + description + optional CTA
 *   - PortalErrorState : icon + message + retry button
 *   - PortalListSkeleton : uniform list loading placeholder
 */

import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/hooks/use-i18n";
import { AlertTriangle, RotateCcw, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PortalEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function PortalErrorState({
  onRetry,
  title,
  description,
  retrying,
  className,
}: {
  onRetry: () => void;
  title?: string;
  description?: string;
  retrying?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Empty className={cn("border border-destructive/30", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyTitle>{title ?? t("portalAutomation.states.errorTitle")}</EmptyTitle>
        <EmptyDescription>
          {description ?? t("portalAutomation.states.errorDescription")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="gap-1.5"
        >
          <RotateCcw className={cn("w-3.5 h-3.5", retrying && "animate-spin")} />
          {t("portalAutomation.states.retry")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function PortalListSkeleton({
  rows = 5,
  rowClassName = "h-16",
  className,
}: {
  rows?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-xl", rowClassName)} />
      ))}
    </div>
  );
}
