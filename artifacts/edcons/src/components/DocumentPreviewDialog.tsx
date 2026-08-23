import { useState, useCallback, type MouseEvent, type ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/hooks/use-i18n";
import { Download } from "lucide-react";
import type { PreviewTarget } from "@/components/documentPreview";

interface PreviewState extends PreviewTarget {}

/**
 * In-app document preview.
 *
 * Behaviour (applies to every "Preview" trigger built with `getTriggerProps`):
 * - Left click (no modifier) -> open the document inside an in-page modal window.
 * - Middle click -> the native anchor opens the file in a background tab without
 *   navigating the user away from the current page.
 * - Ctrl/Cmd/Shift + click -> native browser behaviour (new tab/window).
 */
export function useDocumentPreview() {
  const [state, setState] = useState<PreviewState | null>(null);

  const openPreview = useCallback((target: PreviewTarget) => {
    setState(target);
  }, []);

  const closePreview = useCallback(() => {
    setState((prev) => {
      if (prev?.revokeOnClose && prev.href.startsWith("blob:")) {
        try { URL.revokeObjectURL(prev.href); } catch { /* noop */ }
      }
      return null;
    });
  }, []);

  /** Spread the result onto an `<a>` (or a Button with `asChild` wrapping an `<a>`). */
  const getTriggerProps = useCallback(
    (target: PreviewTarget) => ({
      href: target.href,
      target: "_blank" as const,
      rel: "noopener noreferrer",
      onClick: (e: MouseEvent) => {
        // Only intercept a plain primary (left) click for renderable types.
        // Modifier clicks, middle clicks, and non-previewable types ("other")
        // fall through to the browser's native new-tab handling.
        if (
          target.kind !== "other" &&
          e.button === 0 &&
          !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        ) {
          e.preventDefault();
          openPreview(target);
        }
      },
    }),
    [openPreview],
  );

  const dialog = <DocumentPreviewDialog state={state} onClose={closePreview} />;

  return { previewState: state, openPreview, closePreview, getTriggerProps, dialog };
}

function DocumentPreviewDialog({ state, onClose }: { state: PreviewState | null; onClose: () => void }) {
  const { t } = useI18n();
  let body: ReactNode = null;
  if (state) {
    if (state.kind === "image") {
      body = (
        <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
          <img src={state.href} alt={state.name || "preview"} className="max-w-full max-h-full object-contain" />
        </div>
      );
    } else {
      // pdf (and any other inline-renderable type) -> iframe
      body = (
        <iframe src={state.href} title={state.name || "preview"} className="w-full h-full border-0" />
      );
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl w-[92vw] h-[85vh] p-0 overflow-hidden flex flex-col gap-0">
        <DialogHeader className="px-4 py-3 border-b space-y-0">
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle className="text-sm font-medium truncate">{state?.name || t("common.preview")}</DialogTitle>
            {state && (
              <a
                href={state.downloadHref || state.href}
                download
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                {t("common.download")}
              </a>
            )}
          </div>
        </DialogHeader>
        <div className="flex-1 min-h-0 bg-muted/30">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
