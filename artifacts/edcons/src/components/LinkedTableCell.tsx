import type { ComponentProps } from "react";
import { Link } from "wouter";

import { TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type LinkedTableCellProps = ComponentProps<typeof TableCell> & {
  href: string;
  linkLabel: string;
  primary?: boolean;
};

/**
 * Makes the non-interactive area of a table cell a real link while preserving
 * buttons and nested links inside the cell. One primary cell per row remains
 * keyboard-focusable; the other linked cells provide native mouse context-menu
 * behavior without adding duplicate tab stops.
 */
export function LinkedTableCell({
  href,
  linkLabel,
  primary = false,
  className,
  children,
  ...props
}: LinkedTableCellProps) {
  return (
    <TableCell className={cn("relative", className)} {...props}>
      <Link
        href={href}
        aria-label={primary ? linkLabel : undefined}
        aria-hidden={primary ? undefined : true}
        tabIndex={primary ? undefined : -1}
        className="absolute inset-0 z-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div className="relative z-10 pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
        {children}
      </div>
    </TableCell>
  );
}
