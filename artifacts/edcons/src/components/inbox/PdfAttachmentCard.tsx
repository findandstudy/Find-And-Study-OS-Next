import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { useI18n } from "@/hooks/use-i18n";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PdfIcon() {
  return (
    <div className="w-9 h-10 shrink-0 relative" aria-hidden="true">
      <svg viewBox="0 0 36 40" className="w-full h-full">
        <path d="M4 0 H26 L36 10 V36 a4 4 0 0 1 -4 4 H4 a4 4 0 0 1 -4 -4 V4 a4 4 0 0 1 4 -4 Z" fill="#E53E3E" />
        <path d="M26 0 L36 10 H29 a3 3 0 0 1 -3 -3 Z" fill="#F8B4B4" />
        <text x="18" y="27" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">PDF</text>
      </svg>
    </div>
  );
}

interface PdfAttachmentCardProps {
  url: string;
  /** Server-rendered cached thumbnail (JPEG) endpoint; tried before pdfjs. */
  serverThumbUrl?: string | null;
  name: string;
  fileSize?: number | null;
  outbound?: boolean;
  onClick?: () => void;
}

/**
 * WhatsApp-style PDF attachment card: first-page thumbnail preview on top,
 * red PDF icon + filename + "N pages · size · pdf" meta line below.
 * Thumbnail + page count render lazily via pdfjs; on failure the card
 * degrades gracefully to icon + name + size.
 */
export default function PdfAttachmentCard({ url, serverThumbUrl, name, fileSize, outbound, onClick }: PdfAttachmentCardProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(fileSize ?? null);
  const [serverThumb, setServerThumb] = useState<string | null>(null);
  const [serverThumbFailed, setServerThumbFailed] = useState(false);

  // Defer PDF download/render until the card scrolls into view so long
  // chats with many PDFs don't fetch everything at once.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Server-side cached thumbnail: much cheaper than downloading + rendering
  // the whole PDF in the browser. Falls back to pdfjs when it 404s.
  useEffect(() => {
    if (!visible || !serverThumbUrl) { if (!serverThumbUrl) setServerThumbFailed(true); return; }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const resp = await fetch(serverThumbUrl, { credentials: "include" });
        if (!resp.ok) throw new Error(String(resp.status));
        const pages = Number(resp.headers.get("X-Pdf-Page-Count"));
        const blob = await resp.blob();
        if (!blob.size || !blob.type.toLowerCase().startsWith("image/")) {
          throw new Error("Invalid PDF thumbnail response");
        }
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setServerThumb(objectUrl);
        if (Number.isFinite(pages) && pages > 0) setPageCount(pages);
      } catch {
        if (!cancelled) setServerThumbFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [serverThumbUrl, visible]);

  useEffect(() => {
    if (!visible || serverThumb || !serverThumbFailed) return;
    let cancelled = false;
    setRendered(false);
    setFailed(false);

    async function render() {
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) { if (!cancelled) setFailed(true); return; }
        const data = await resp.arrayBuffer();
        if (cancelled) return;
        if (fileSize == null && data.byteLength > 0) setSizeBytes(data.byteLength);

        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        const page = await pdf.getPage(1);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const unscaled = page.getViewport({ scale: 1 });
        const targetWidth = 480;
        const scale = targetWidth / unscaled.width;
        const viewport = page.getViewport({ scale });

        canvas.width = viewport.width;
        // Crop tall pages to a WhatsApp-like banner aspect (~2.2:1).
        canvas.height = Math.min(viewport.height, Math.round(viewport.width / 2.2));

        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, visible, serverThumb, serverThumbFailed]);

  const metaParts: string[] = [];
  if (pageCount != null) metaParts.push(t("inbox.attachment.pageCount", { count: String(pageCount) }));
  if (sizeBytes != null && sizeBytes > 0) metaParts.push(formatBytes(sizeBytes));
  metaParts.push("pdf");

  return (
    <button
      ref={rootRef}
      type="button"
      onClick={onClick}
      className={`block w-full max-w-[280px] text-left rounded-xl overflow-hidden border transition-colors ${
        outbound
          ? "border-primary-foreground/25 bg-primary-foreground/10 hover:bg-primary-foreground/20 text-primary-foreground"
          : "border-border bg-muted/40 hover:bg-muted text-foreground"
      }`}
    >
      {serverThumb ? (
        <img
          src={serverThumb}
          alt={name}
          className="w-full block bg-white object-cover object-top max-h-[130px]"
          onError={() => {
            setServerThumb(null);
            setServerThumbFailed(true);
          }}
        />
      ) : !failed && (
        <canvas
          ref={canvasRef}
          className="w-full block bg-white"
          style={{ display: rendered ? undefined : "none" }}
          aria-label={name}
        />
      )}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <PdfIcon />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium leading-snug break-words line-clamp-2">{name}</p>
          <p className={`text-[10px] mt-0.5 ${outbound ? "opacity-60" : "text-muted-foreground"}`}>
            {metaParts.join(" · ")}
          </p>
        </div>
      </div>
    </button>
  );
}
