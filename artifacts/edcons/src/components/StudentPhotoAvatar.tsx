import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

const PdfPhotoAvatar = lazy(() => import("@/components/PdfPhotoAvatar"));

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface StudentPhotoAvatarProps {
  studentId: number | null | undefined;
  firstName?: string;
  lastName?: string;
  /** Tailwind classes for size + shape. Default: w-14 h-14 rounded-full */
  className?: string;
}

/**
 * Shared student photo avatar used in Lead, Student, and Application detail headers.
 * Handles image, PDF (canvas render), skeleton loading, and initial-letter fallback.
 * View-only — upload/change is handled only on Student Detail.
 */
export function StudentPhotoAvatar({
  studentId,
  firstName = "",
  lastName = "",
  className = "w-14 h-14 rounded-full",
}: StudentPhotoAvatarProps) {
  const initials = `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";
  const [imgError, setImgError] = useState(false);

  const fallback = (
    <div
      className={`${className} bg-primary/10 flex items-center justify-center text-primary font-bold border-2 border-primary/20 select-none`}
      aria-label={`${firstName} ${lastName}`}
    >
      {initials}
    </div>
  );

  // Lightweight fetch: read Content-Type header, cancel body immediately.
  const { data: mimeType, isLoading } = useQuery<string | null>({
    queryKey: ["student-photo-mime", studentId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/students/${studentId}/photo`, {
        credentials: "include",
      });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return null;
      }
      const ct = res.headers.get("content-type") || "image/jpeg";
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return ct;
    },
    enabled: !!studentId,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!studentId) return fallback;
  if (isLoading) return <Skeleton className={className} />;
  if (!mimeType) return fallback;

  const src = `${BASE_URL}/api/students/${studentId}/photo`;

  if (mimeType.includes("pdf")) {
    return (
      <Suspense fallback={fallback}>
        <PdfPhotoAvatar
          src={src}
          className={`${className} object-cover border-2 border-primary/20`}
          alt={`${firstName} ${lastName}`}
          fallback={fallback}
        />
      </Suspense>
    );
  }

  if (imgError) return fallback;

  return (
    <img
      src={src}
      alt={`${firstName} ${lastName}`}
      className={`${className} object-cover border-2 border-primary/20`}
      onError={() => setImgError(true)}
    />
  );
}
