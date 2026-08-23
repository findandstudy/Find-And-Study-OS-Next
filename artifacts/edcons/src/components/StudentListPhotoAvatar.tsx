import { useEffect, useRef, useState } from "react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface StudentListPhotoAvatarProps {
  studentId: number | null | undefined;
  firstName?: string;
  lastName?: string;
  photoUrl?: string | null;
  size?: "sm" | "md";
}

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Canonical student avatar for table and kanban lists.
 *
 * The student detail page can render both image and PDF photo documents. Lists
 * must use the same source of truth instead of trusting the denormalized
 * `hasPhoto` flag, which can be stale for older/imported records.
 */
export function StudentListPhotoAvatar({
  studentId,
  firstName = "",
  lastName = "",
  photoUrl,
  size = "sm",
}: StudentListPhotoAvatarProps) {
  const dim = size === "md" ? "w-10 h-10" : "w-8 h-8";
  const textSize = size === "md" ? "text-sm" : "text-xs";
  const initials = `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [useProvidedFallback, setUseProvidedFallback] = useState(false);

  useEffect(() => {
    setImgError(false);
    setUseProvidedFallback(false);
  }, [studentId, photoUrl]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [studentId]);

  const fallback = (
    <div className={`${dim} rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center`}>
      <span className={`${textSize} font-bold text-primary`}>{initials}</span>
    </div>
  );

  let content = fallback;
  const canonicalThumbnailUrl = studentId
    ? `${BASE_URL}/api/students/${studentId}/photo/thumbnail`
    : null;
  const providedPhotoUrl = photoUrl ? resolveApiUrl(photoUrl) : null;
  const thumbnailUrl = useProvidedFallback
    ? providedPhotoUrl
    : canonicalThumbnailUrl ?? providedPhotoUrl;

  if (inView && thumbnailUrl && !imgError) {
    content = (
      <img
        src={thumbnailUrl}
        alt={`${firstName} ${lastName}`.trim()}
        className={`${dim} rounded-full object-cover border border-primary/20`}
        loading="lazy"
        decoding="async"
        onError={() => {
          if (
            canonicalThumbnailUrl
            && thumbnailUrl === canonicalThumbnailUrl
            && providedPhotoUrl
            && providedPhotoUrl !== canonicalThumbnailUrl
          ) {
            setUseProvidedFallback(true);
            return;
          }
          setImgError(true);
        }}
      />
    );
  }

  return (
    <div ref={containerRef} className={`${dim} rounded-full shrink-0 overflow-hidden`}>
      {content}
    </div>
  );
}
