/**
 * Serializes all headless-Chromium PDF renders across the process.
 * Chromium is memory-heavy; two or more concurrent renders multiply RSS and
 * can OOM-kill the instance mid-request, causing the edge proxy to return an
 * opaque "403 Forbidden" HTML instead of the PDF.  Chaining renders behind a
 * single promise guarantees at most ONE browser instance runs at a time.
 */
let renderChain: Promise<unknown> = Promise.resolve();

export function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderChain.then(fn, fn);
  renderChain = run.then(() => undefined, () => undefined);
  return run;
}
