import { useEffect, useRef, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, X, RotateCcw, Plus, Check, Loader2, AlertTriangle, FileText, Sun, Hand, Crop, Upload } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";

const OPENCV_URL = "https://docs.opencv.org/4.10.0/opencv.js";
const JSCANIFY_URL = "https://cdn.jsdelivr.net/npm/jscanify@1.3.0/src/jscanify.min.js";
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

type LibStatus = "idle" | "loading" | "ready" | "error";
let cachedStatus: LibStatus = "idle";
let cachedPromise: Promise<void> | null = null;
let cachedScanner: any = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-scanner-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as any)._loaded) resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("script load failed")));
      }
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.setAttribute("data-scanner-src", src);
    s.onload = () => { (s as any)._loaded = true; resolve(); };
    s.onerror = () => reject(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}

async function ensureScannerLibs(): Promise<any> {
  if (cachedScanner) return cachedScanner;
  if (cachedPromise) {
    await cachedPromise;
    return cachedScanner;
  }
  cachedStatus = "loading";
  cachedPromise = (async () => {
    await loadScript(OPENCV_URL);
    await new Promise<void>((resolve, reject) => {
      const w = window as any;
      const start = Date.now();
      function check() {
        if (w.cv && (typeof w.cv.Mat === "function" || (w.cv.then && typeof w.cv.then === "function"))) {
          if (typeof w.cv.Mat === "function") return resolve();
          w.cv.then(() => resolve()).catch(reject);
          return;
        }
        if (Date.now() - start > 30000) return reject(new Error("opencv runtime timeout"));
        setTimeout(check, 100);
      }
      check();
    });
    await loadScript(JSCANIFY_URL);
    await loadScript(JSPDF_URL);
    const w = window as any;
    if (!w.jscanify) throw new Error("jscanify global missing");
    if (!w.jspdf?.jsPDF) throw new Error("jspdf global missing");
    cachedScanner = new w.jscanify();
    cachedStatus = "ready";
  })();
  try {
    await cachedPromise;
  } catch (e) {
    cachedStatus = "error";
    cachedPromise = null;
    throw e;
  }
  return cachedScanner;
}

interface CapturedPage {
  dataUrl: string;
  blob: Blob;
}

type ScanMode = "color" | "bw";
type Corner = { x: number; y: number };
type Corners = { tl: Corner; tr: Corner; br: Corner; bl: Corner };

interface AdjustState {
  snap: HTMLCanvasElement;
  corners: Corners;
}

interface DocumentScannerProps {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  /** Base name for the output file (without extension). Defaults to "scan". */
  baseName?: string;
  /** Allow capturing multiple pages and bundling as PDF. Defaults to true. */
  allowMultiPage?: boolean;
}

export function DocumentScanner({ open, onClose, onCapture, baseName = "scan", allowMultiPage = true }: DocumentScannerProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const scannerRef = useRef<any>(null);
  const lastFrameRef = useRef<ImageData | null>(null);
  const lightSampleRef = useRef<number>(0);

  const [libStatus, setLibStatus] = useState<LibStatus>(cachedStatus);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pages, setPages] = useState<CapturedPage[]>([]);
  const [adjust, setAdjust] = useState<AdjustState | null>(null);
  const [previewPage, setPreviewPage] = useState<CapturedPage | null>(null);
  const [processing, setProcessing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<ScanMode>("color");
  const [lowLight, setLowLight] = useState(false);
  const [shaky, setShaky] = useState(false);

  // Lazy-load OpenCV + jscanify on first open.
  useEffect(() => {
    if (!open) return;
    if (cachedStatus === "ready") {
      setLibStatus("ready");
      scannerRef.current = cachedScanner;
      return;
    }
    setLibStatus("loading");
    ensureScannerLibs()
      .then((s) => { scannerRef.current = s; setLibStatus("ready"); })
      .catch(() => setLibStatus("error"));
  }, [open]);

  // Start camera once libs are ready (or when reopened).
  useEffect(() => {
    if (!open || libStatus !== "ready" || previewPage || adjust) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      if (location.protocol !== "https:" && location.hostname !== "localhost") {
        setCameraError(t("scanner.httpsRequired"));
      } else {
        setCameraError(t("scanner.noCamera"));
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play().catch(() => {});
        lastFrameRef.current = null;
        lightSampleRef.current = 0;
        startOverlayLoop();
      } catch (err: any) {
        const name = err?.name || "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setCameraError(t("scanner.permissionDenied"));
        } else if (name === "NotFoundError") {
          setCameraError(t("scanner.noCamera"));
        } else if (location.protocol !== "https:" && location.hostname !== "localhost") {
          setCameraError(t("scanner.httpsRequired"));
        } else {
          setCameraError(t("scanner.cameraError"));
        }
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, libStatus, previewPage, adjust]);

  function stopCamera() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }

  function startOverlayLoop() {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 64;
    sampleCanvas.height = 36;
    const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });

    const draw = () => {
      const v = videoRef.current;
      const c = overlayRef.current;
      const scanner = scannerRef.current;
      if (!v || !c || !scanner || v.readyState < 2) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      try {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        if (c.width !== vw) c.width = vw;
        if (c.height !== vh) c.height = vh;
        const ctx = c.getContext("2d");
        if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }
        ctx.clearRect(0, 0, vw, vh);
        try {
          const highlighted: HTMLCanvasElement = scanner.highlightPaper(v, {
            color: "#22c55e",
            thickness: Math.max(4, Math.round(vw / 240)),
          });
          ctx.globalAlpha = 0.6;
          ctx.drawImage(highlighted, 0, 0, vw, vh);
          ctx.globalAlpha = 1;
        } catch {/* no paper */}

        // Sample brightness + motion every ~8 frames (~7Hz)
        lightSampleRef.current = (lightSampleRef.current + 1) % 8;
        if (lightSampleRef.current === 0 && sctx) {
          try {
            sctx.drawImage(v, 0, 0, sampleCanvas.width, sampleCanvas.height);
            const id = sctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
            const d = id.data;
            let lum = 0;
            for (let i = 0; i < d.length; i += 4) {
              lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            }
            lum = lum / (d.length / 4);
            const dim = lum < 65;
            setLowLight(prev => prev === dim ? prev : dim);

            const prev = lastFrameRef.current;
            if (prev && prev.data.length === d.length && lum >= 25) {
              let diff = 0;
              for (let i = 0; i < d.length; i += 4) {
                diff += Math.abs(d[i] - prev.data[i]);
              }
              const meanDiff = diff / (d.length / 4);
              const sh = meanDiff > 22;
              setShaky(cur => cur === sh ? cur : sh);
            }
            lastFrameRef.current = id;
          } catch {/* sampling failed */}
        }
      } catch {/* ignore one-frame errors */}
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
  }

  const handleCapture = useCallback(async () => {
    const v = videoRef.current;
    const scanner = scannerRef.current;
    if (!v || !scanner || v.readyState < 2) return;
    setProcessing(true);
    try {
      const snap = document.createElement("canvas");
      snap.width = v.videoWidth;
      snap.height = v.videoHeight;
      const sctx = snap.getContext("2d");
      if (!sctx) throw new Error("ctx");
      sctx.drawImage(v, 0, 0, snap.width, snap.height);

      const corners = detectCorners(scanner, snap);
      stopCamera();
      setAdjust({ snap, corners });
    } catch {/* swallow */}
    setProcessing(false);
  }, []);

  // Apply manual corners + warp + enhancement.
  const applyAdjust = useCallback(async () => {
    if (!adjust) return;
    setProcessing(true);
    try {
      const { snap, corners } = adjust;
      // Output size: estimate from corners, capped.
      const wTop = dist(corners.tl, corners.tr);
      const wBot = dist(corners.bl, corners.br);
      const hLeft = dist(corners.tl, corners.bl);
      const hRight = dist(corners.tr, corners.br);
      let outW = Math.max(wTop, wBot);
      let outH = Math.max(hLeft, hRight);
      const MAX = 1600;
      const longest = Math.max(outW, outH);
      if (longest > MAX) {
        const s = MAX / longest;
        outW *= s; outH *= s;
      }
      outW = Math.max(200, Math.round(outW));
      outH = Math.max(200, Math.round(outH));

      let warped: HTMLCanvasElement;
      try {
        warped = warpPerspective(snap, corners, outW, outH);
      } catch {
        warped = document.createElement("canvas");
        warped.width = outW;
        warped.height = outH;
        warped.getContext("2d")!.drawImage(snap, 0, 0, outW, outH);
      }

      let enhanced: HTMLCanvasElement;
      if (mode === "bw") {
        enhanced = toBlackWhite(warped);
      } else {
        autoWhiteBalance(warped);
        enhanced = enhanceContrast(warped);
      }

      const blob: Blob = await new Promise((resolve, reject) => {
        enhanced.toBlob(b => b ? resolve(b) : reject(new Error("blob")), "image/jpeg", 0.92);
      });
      const dataUrl = enhanced.toDataURL("image/jpeg", 0.92);
      setPreviewPage({ dataUrl, blob });
      setAdjust(null);
    } catch {/* swallow */}
    setProcessing(false);
  }, [adjust, mode]);

  function cancelAdjust() {
    setAdjust(null);
  }

  function acceptPreview() {
    if (!previewPage) return;
    setPages(prev => [...prev, previewPage]);
    setPreviewPage(null);
  }

  function retake() {
    setPreviewPage(null);
  }

  async function finish(includeCurrent: boolean) {
    setBuilding(true);
    try {
      let allPages = [...pages];
      if (includeCurrent && previewPage) allPages = [...allPages, previewPage];
      if (allPages.length === 0) { setBuilding(false); return; }
      const ts = Date.now();
      if (allPages.length === 1) {
        const file = new File([allPages[0].blob], `${baseName}-${ts}.jpg`, { type: "image/jpeg" });
        onCapture(file);
      } else {
        const jsPDF = (window as any).jspdf?.jsPDF;
        if (!jsPDF) throw new Error("jspdf missing");
        const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
        for (let i = 0; i < allPages.length; i++) {
          const dataUrl = allPages[i].dataUrl;
          const img = await loadImage(dataUrl);
          const pageW = pdf.internal.pageSize.getWidth();
          const pageH = pdf.internal.pageSize.getHeight();
          const ratio = Math.min(pageW / img.width, pageH / img.height);
          const w = img.width * ratio;
          const h = img.height * ratio;
          const x = (pageW - w) / 2;
          const y = (pageH - h) / 2;
          if (i > 0) pdf.addPage();
          pdf.addImage(dataUrl, "JPEG", x, y, w, h, undefined, "FAST");
        }
        const blob = pdf.output("blob");
        const file = new File([blob], `${baseName}-${ts}.pdf`, { type: "application/pdf" });
        onCapture(file);
      }
      setPages([]);
      setPreviewPage(null);
      setAdjust(null);
      onClose();
    } catch {/* swallow */}
    setBuilding(false);
  }

  function handleClose() {
    stopCamera();
    setPages([]);
    setPreviewPage(null);
    setAdjust(null);
    setCameraError(null);
    setLowLight(false);
    setShaky(false);
    onClose();
  }

  function openDeviceCapture() {
    fallbackInputRef.current?.click();
  }

  function handleDeviceCapture(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    stopCamera();
    onCapture(file);
    handleClose();
  }

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), []);

  const totalPages = pages.length + (previewPage ? 1 : 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl w-[96vw] p-0 overflow-hidden bg-black border-0 sm:rounded-2xl h-[92vh] sm:h-auto sm:max-h-[92vh] flex flex-col">
        <input
          ref={fallbackInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          tabIndex={-1}
          onChange={handleDeviceCapture}
        />
        <VisuallyHidden.Root>
          <DialogTitle>{t("scanner.title")}</DialogTitle>
        </VisuallyHidden.Root>
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-black/80 text-white text-sm shrink-0">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4" />
            <span className="font-semibold">{t("scanner.title")}</span>
            {pages.length > 0 && (
              <span className="ml-2 text-xs bg-white/15 px-2 py-0.5 rounded-full">
                {t("scanner.pageCount", { n: pages.length })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Mode toggle */}
            <div className="hidden sm:flex items-center bg-white/10 rounded-full p-0.5">
              <button
                onClick={() => setMode("color")}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${mode === "color" ? "bg-white text-black" : "text-white/80 hover:text-white"}`}
                aria-pressed={mode === "color"}
              >
                {t("scanner.modeColor")}
              </button>
              <button
                onClick={() => setMode("bw")}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${mode === "bw" ? "bg-white text-black" : "text-white/80 hover:text-white"}`}
                aria-pressed={mode === "bw"}
              >
                {t("scanner.modeBw")}
              </button>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-full hover:bg-white/10" aria-label={t("scanner.close")}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mobile mode toggle */}
        <div className="sm:hidden flex items-center justify-center bg-black/80 pb-2 shrink-0">
          <div className="flex items-center bg-white/10 rounded-full p-0.5">
            <button
              onClick={() => setMode("color")}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${mode === "color" ? "bg-white text-black" : "text-white/80"}`}
            >
              {t("scanner.modeColor")}
            </button>
            <button
              onClick={() => setMode("bw")}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${mode === "bw" ? "bg-white text-black" : "text-white/80"}`}
            >
              {t("scanner.modeBw")}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
          {libStatus === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 p-6 text-center">
              <Loader2 className="w-10 h-10 animate-spin" />
              <p className="text-sm font-semibold">{t("scanner.loading")}</p>
              <p className="text-xs text-white/70 max-w-xs">{t("scanner.loadingHint")}</p>
              <Button variant="secondary" size="sm" onClick={openDeviceCapture} className="gap-2">
                <Upload className="w-4 h-4" /> {t("common.upload")}
              </Button>
            </div>
          )}
          {libStatus === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 p-6 text-center">
              <AlertTriangle className="w-10 h-10 text-amber-400" />
              <p className="text-sm font-semibold">{t("scanner.libError")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={openDeviceCapture} className="gap-2"><Upload className="w-4 h-4" /> {t("common.upload")}</Button>
                <Button variant="secondary" size="sm" onClick={handleClose}>{t("scanner.close")}</Button>
              </div>
            </div>
          )}
          {libStatus === "ready" && cameraError && !previewPage && !adjust && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 p-6 text-center">
              <AlertTriangle className="w-10 h-10 text-amber-400" />
              <p className="text-sm font-semibold max-w-sm">{cameraError}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={openDeviceCapture} className="gap-2"><Upload className="w-4 h-4" /> {t("common.upload")}</Button>
                <Button variant="secondary" size="sm" onClick={handleClose}>{t("scanner.close")}</Button>
              </div>
            </div>
          )}

          {/* Live capture view */}
          {libStatus === "ready" && !cameraError && !previewPage && !adjust && (
            <div className="relative w-full h-full">
              <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" muted playsInline />
              <canvas ref={overlayRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
                {t("scanner.positionDoc")}
              </div>
              {(lowLight || shaky) && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none">
                  {lowLight && (
                    <div className="flex items-center gap-1.5 bg-amber-500/90 text-black text-xs font-medium px-3 py-1.5 rounded-full shadow-lg">
                      <Sun className="w-3.5 h-3.5" />
                      {t("scanner.lowLight")}
                    </div>
                  )}
                  {shaky && (
                    <div className="flex items-center gap-1.5 bg-rose-500/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg">
                      <Hand className="w-3.5 h-3.5" />
                      {t("scanner.shaky")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Manual corner adjustment view */}
          {adjust && (
            <CornerEditor
              snap={adjust.snap}
              corners={adjust.corners}
              onChange={(c) => setAdjust(prev => prev ? { ...prev, corners: c } : prev)}
              hint={t("scanner.dragCorners")}
            />
          )}

          {/* Preview view */}
          {previewPage && (
            <div className="relative w-full h-full flex items-center justify-center p-2">
              <img src={previewPage.dataUrl} alt="" className="max-w-full max-h-full object-contain rounded" />
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
                {t("scanner.previewLabel", { n: pages.length + 1 })}
              </div>
            </div>
          )}

          {processing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white gap-2">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-sm">{t("scanner.processing")}</span>
            </div>
          )}
        </div>

        {/* Thumbnails strip */}
        {pages.length > 0 && (
          <div className="flex gap-2 overflow-x-auto p-2 bg-black/70 shrink-0">
            {pages.map((p, i) => (
              <div key={i} className="relative shrink-0">
                <img src={p.dataUrl} alt="" className="h-16 w-12 object-cover rounded border border-white/20" />
                <button
                  onClick={() => setPages(prev => prev.filter((_, idx) => idx !== i))}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center"
                  aria-label={t("scanner.removePage")}
                >
                  <X className="w-3 h-3" />
                </button>
                <span className="absolute bottom-0 left-0 right-0 text-[10px] text-center text-white bg-black/60 rounded-b">{i + 1}</span>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="bg-black/90 p-3 shrink-0 flex flex-wrap items-center justify-center gap-2">
          {libStatus === "ready" && !cameraError && !previewPage && !adjust && (
            <>
              <Button
                onClick={handleCapture}
                disabled={processing}
                className="bg-white text-black hover:bg-white/90 gap-2 h-12 px-6 rounded-full font-semibold"
              >
                <Camera className="w-5 h-5" />
                {t("scanner.capture")}
              </Button>
              <Button variant="secondary" onClick={openDeviceCapture} className="gap-2 h-12 rounded-full">
                <Upload className="w-4 h-4" /> {t("common.upload")}
              </Button>
            </>
          )}
          {adjust && !processing && (
            <>
              <Button variant="secondary" onClick={cancelAdjust} className="gap-2">
                <RotateCcw className="w-4 h-4" /> {t("scanner.retake")}
              </Button>
              <Button onClick={applyAdjust} className="gap-2">
                <Crop className="w-4 h-4" /> {t("scanner.applyCrop")}
              </Button>
            </>
          )}
          {previewPage && !building && (
            <>
              <Button variant="secondary" onClick={retake} className="gap-2">
                <RotateCcw className="w-4 h-4" /> {t("scanner.retake")}
              </Button>
              {allowMultiPage && (
                <Button variant="secondary" onClick={acceptPreview} className="gap-2">
                  <Plus className="w-4 h-4" /> {t("scanner.addPage")}
                </Button>
              )}
              <Button onClick={() => finish(true)} className="gap-2">
                {totalPages > 1 ? <FileText className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                {totalPages > 1 ? t("scanner.finishPdf", { n: totalPages }) : t("scanner.use")}
              </Button>
            </>
          )}
          {building && (
            <div className="text-white flex items-center gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("scanner.building")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------- Corner editor ----------------- */

function CornerEditor({ snap, corners, onChange, hint }: {
  snap: HTMLCanvasElement;
  corners: Corners;
  onChange: (c: Corners) => void;
  hint: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgRect, setImgRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dataUrl] = useState(() => snap.toDataURL("image/jpeg", 0.85));
  const dragRef = useRef<keyof Corners | null>(null);

  // Compute the on-screen rect of the displayed image (object-contain).
  function recompute() {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img) return;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const ratio = Math.min(cw / snap.width, ch / snap.height);
    const w = snap.width * ratio;
    const h = snap.height * ratio;
    const x = (cw - w) / 2;
    const y = (ch - h) / 2;
    setImgRect({ x, y, w, h });
  }
  useEffect(() => {
    recompute();
    const ro = new ResizeObserver(() => recompute());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap]);

  function toScreen(c: Corner): Corner {
    if (!imgRect) return { x: 0, y: 0 };
    return {
      x: imgRect.x + (c.x / snap.width) * imgRect.w,
      y: imgRect.y + (c.y / snap.height) * imgRect.h,
    };
  }
  function toImage(sx: number, sy: number): Corner {
    if (!imgRect) return { x: 0, y: 0 };
    let x = ((sx - imgRect.x) / imgRect.w) * snap.width;
    let y = ((sy - imgRect.y) / imgRect.h) * snap.height;
    x = Math.max(0, Math.min(snap.width, x));
    y = Math.max(0, Math.min(snap.height, y));
    return { x, y };
  }

  function onPointerDown(key: keyof Corners) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = key;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const c = toImage(sx, sy);
    onChange({ ...corners, [dragRef.current]: c });
  }
  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    }
    dragRef.current = null;
  }

  const order: (keyof Corners)[] = ["tl", "tr", "br", "bl"];
  const screenCorners = order.map(k => toScreen(corners[k]));

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full select-none touch-none"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        ref={imgRef}
        src={dataUrl}
        alt=""
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        onLoad={recompute}
      />
      {imgRect && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: "visible" }}>
          <polygon
            points={screenCorners.map(p => `${p.x},${p.y}`).join(" ")}
            fill="rgba(34,197,94,0.18)"
            stroke="#22c55e"
            strokeWidth={2}
          />
        </svg>
      )}
      {imgRect && order.map((k, i) => {
        const p = screenCorners[i];
        return (
          <div
            key={k}
            role="slider"
            aria-label={`corner-${k}`}
            onPointerDown={onPointerDown(k)}
            className="absolute w-9 h-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/95 border-2 border-emerald-500 shadow-lg cursor-grab active:cursor-grabbing touch-none"
            style={{ left: p.x, top: p.y }}
          >
            <div className="absolute inset-1.5 rounded-full bg-emerald-500" />
          </div>
        );
      })}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
        {hint}
      </div>
    </div>
  );
}

/* ----------------- Image processing helpers ----------------- */

function dist(a: Corner, b: Corner): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function detectCorners(scanner: any, snap: HTMLCanvasElement): Corners {
  const cv = (window as any).cv;
  // Sensible default: inset 4% rectangle.
  const ix = snap.width * 0.04;
  const iy = snap.height * 0.04;
  const fallback: Corners = {
    tl: { x: ix, y: iy },
    tr: { x: snap.width - ix, y: iy },
    br: { x: snap.width - ix, y: snap.height - iy },
    bl: { x: ix, y: snap.height - iy },
  };
  if (!cv || !scanner) return fallback;
  let src: any = null;
  try {
    src = cv.imread(snap);
    const contour = scanner.findPaperContour(src);
    if (!contour) return fallback;
    const cp = scanner.getCornerPoints(contour, src);
    const ok = cp && cp.topLeftCorner && cp.topRightCorner && cp.bottomLeftCorner && cp.bottomRightCorner;
    if (!ok) return fallback;
    return {
      tl: { x: cp.topLeftCorner.x, y: cp.topLeftCorner.y },
      tr: { x: cp.topRightCorner.x, y: cp.topRightCorner.y },
      br: { x: cp.bottomRightCorner.x, y: cp.bottomRightCorner.y },
      bl: { x: cp.bottomLeftCorner.x, y: cp.bottomLeftCorner.y },
    };
  } catch {
    return fallback;
  } finally {
    if (src) try { src.delete(); } catch {}
  }
}

function warpPerspective(snap: HTMLCanvasElement, c: Corners, outW: number, outH: number): HTMLCanvasElement {
  const cv = (window as any).cv;
  const src = cv.imread(snap);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    c.tl.x, c.tl.y,
    c.tr.x, c.tr.y,
    c.br.x, c.br.y,
    c.bl.x, c.bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW, 0,
    outW, outH,
    0, outH,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  cv.imshow(out, dst);
  src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
  return out;
}

function toBlackWhite(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const cv = (window as any).cv;
  if (!cv) return canvas;
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // Light denoise before thresholding
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const dst = new cv.Mat();
  // Block size must be odd; tune from image width for stability across resolutions.
  const block = Math.max(15, (Math.floor(canvas.width / 60) | 1));
  cv.adaptiveThreshold(blurred, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  cv.imshow(out, dst);
  src.delete(); gray.delete(); blurred.delete(); dst.delete();
  return out;
}

function autoWhiteBalance(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  try {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    let r = 0, g = 0, b = 0, n = 0;
    // Sample every 4th pixel (16 bytes) for speed.
    for (let i = 0; i < d.length; i += 16) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (n === 0) return canvas;
    const ar = r / n, ag = g / n, ab = b / n;
    const avg = (ar + ag + ab) / 3;
    if (ar < 1 || ag < 1 || ab < 1) return canvas;
    let kr = avg / ar, kg = avg / ag, kb = avg / ab;
    // Damp to avoid over-correction on already-balanced images.
    kr = 1 + (kr - 1) * 0.85;
    kg = 1 + (kg - 1) * 0.85;
    kb = 1 + (kb - 1) * 0.85;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = clamp(d[i]     * kr);
      d[i + 1] = clamp(d[i + 1] * kg);
      d[i + 2] = clamp(d[i + 2] * kb);
    }
    ctx.putImageData(img, 0, 0);
  } catch {/* CORS/perf */}
  return canvas;
}

function enhanceContrast(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  try {
    const img = ctx.getImageData(0, 0, src.width, src.height);
    const d = img.data;
    const contrast = 1.15;
    const brightness = 8;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = clamp((d[i]     - 128) * contrast + 128 + brightness);
      d[i + 1] = clamp((d[i + 1] - 128) * contrast + 128 + brightness);
      d[i + 2] = clamp((d[i + 2] - 128) * contrast + 128 + brightness);
    }
    ctx.putImageData(img, 0, 0);
  } catch {/* CORS/perf */}
  return src;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Small helper button others can drop into upload UIs. */
export function ScanButton({ onClick, className, label }: { onClick: () => void; className?: string; label?: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={className ?? "inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 px-2.5 py-1 rounded-md hover:bg-primary/5 transition-colors"}
    >
      <Camera className="w-3.5 h-3.5" />
      {label ?? t("scanner.scanWithCamera")}
    </button>
  );
}
