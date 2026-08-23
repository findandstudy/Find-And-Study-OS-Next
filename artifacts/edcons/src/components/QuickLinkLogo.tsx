import { useState, useEffect } from "react";

interface QuickLinkLogoProps {
  logoUrl?: string | null;
  title: string;
  icon?: string | null;
  color?: string | null;
  className?: string;
  /** Called when a non-empty logoUrl fails to load (missing/unreachable object). */
  onImageError?: () => void;
}

/**
 * Renders a quick-link badge: the uploaded logo image when available, otherwise
 * a colored badge with the link's icon or first letter. If the logo image fails
 * to load (missing/unreachable object on the backend), it gracefully falls back
 * to the colored badge instead of showing a broken-image icon.
 */
export function QuickLinkLogo({ logoUrl, title, icon, color, className = "w-9 h-9", onImageError }: QuickLinkLogoProps) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [logoUrl]);

  const showImage = Boolean(logoUrl) && !errored;

  return (
    <div
      className={`${className} rounded-lg flex items-center justify-center shrink-0 text-white text-sm font-bold overflow-hidden`}
      style={{ backgroundColor: showImage ? "transparent" : (color || "#6366f1") }}
    >
      {showImage ? (
        <img
          src={logoUrl as string}
          alt={title}
          className="w-full h-full object-contain"
          onError={() => {
            setErrored(true);
            onImageError?.();
          }}
        />
      ) : (
        icon || title.charAt(0).toUpperCase()
      )}
    </div>
  );
}
