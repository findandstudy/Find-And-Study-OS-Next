import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfPhotoAvatarProps {
  src: string;
  className?: string;
  alt?: string;
  fallback?: React.ReactNode;
}

export default function PdfPhotoAvatar({ src, className, alt, fallback }: PdfPhotoAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRendered(false);
    setFailed(false);

    async function render() {
      try {
        const resp = await fetch(src, { credentials: "include" });
        if (!resp.ok) { if (!cancelled) setFailed(true); return; }
        const data = await resp.arrayBuffer();

        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const page = await pdf.getPage(1);

        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const unscaled = page.getViewport({ scale: 1 });
        const targetPx = 160;
        const scale = targetPx / Math.max(unscaled.width, unscaled.height);
        const viewport = page.getViewport({ scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext("2d")!;
        // pdfjs-dist RenderParameters type varies across versions; bypass via any.
        const renderTask = (page.render as (p: { canvasContext: object; viewport: object }) => { promise: Promise<void> })(
          { canvasContext: ctx, viewport },
        );
        await renderTask.promise;

        if (!cancelled) setRendered(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    render();
    return () => { cancelled = true; };
  }, [src]);

  if (failed) return <>{fallback ?? null}</>;

  return (
    <>
      {!rendered && fallback}
      <canvas
        ref={canvasRef}
        className={className}
        aria-label={alt}
        style={{ display: rendered ? undefined : "none" }}
      />
    </>
  );
}
