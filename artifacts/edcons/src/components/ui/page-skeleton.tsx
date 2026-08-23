export function DashboardSkeleton() {
  return (
    <div className="space-y-8 animate-pulse p-4 lg:p-6">
      <div className="space-y-2">
        <div className="h-8 w-48 bg-muted rounded-lg" />
        <div className="h-4 w-72 bg-muted rounded" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 h-80 bg-muted rounded-xl" />
        <div className="h-80 bg-muted rounded-xl" />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-6 animate-pulse p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-40 bg-muted rounded-lg" />
        <div className="h-10 w-32 bg-muted rounded-lg" />
      </div>
      <div className="flex gap-3">
        <div className="h-10 w-64 bg-muted rounded-lg" />
        <div className="h-10 w-28 bg-muted rounded-lg" />
      </div>
      <div className="space-y-2">
        <div className="h-10 bg-muted rounded-lg" />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-14 bg-muted/60 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
