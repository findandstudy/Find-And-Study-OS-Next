const BACKGROUND_JOBS_LOCK_ID = 1_579_243_811;

type AdvisoryClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

type AdvisoryPool = { connect(): Promise<AdvisoryClient> };

export type BackgroundJobStop = () => void | Promise<void>;

export type BackgroundJobDefinition = {
  name: string;
  offsetMs: number;
  start: () => void | BackgroundJobStop | Promise<void | BackgroundJobStop>;
};

export function backgroundJobsEnabled(
  raw = process.env.BACKGROUND_JOBS_ENABLED,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== undefined) {
    console.warn(`[background-jobs] Invalid BACKGROUND_JOBS_ENABLED=${JSON.stringify(raw)}; disabled`);
    return false;
  }
  return nodeEnv === "development" || nodeEnv === "test";
}

export class BackgroundJobCoordinator {
  private client: AdvisoryClient | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stops: BackgroundJobStop[] = [];
  private stopping = false;

  constructor(
    private readonly pool: AdvisoryPool,
    private readonly jobs: BackgroundJobDefinition[],
    private readonly schedule: typeof setTimeout = setTimeout,
    private readonly cancel: typeof clearTimeout = clearTimeout,
  ) {}

  async start(enabled = backgroundJobsEnabled()): Promise<boolean> {
    if (!enabled) {
      console.log("[background-jobs] Disabled; HTTP API will run without schedulers");
      return false;
    }
    const client = await this.pool.connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [BACKGROUND_JOBS_LOCK_ID],
    );
    if (result.rows[0]?.locked !== true) {
      client.release();
      console.warn("[background-jobs] Advisory lock is owned by another API instance; schedulers not started");
      return false;
    }
    this.client = client;
    for (const job of this.jobs) {
      const timer = this.schedule(() => {
        this.timers.delete(timer);
        if (this.stopping) return;
        Promise.resolve(job.start())
          .then((stop) => { if (typeof stop === "function") this.stops.push(stop); })
          .catch((error) => console.error(`[background-jobs] ${job.name} start failed:`, error));
      }, job.offsetMs);
      timer.unref?.();
      this.timers.add(timer);
    }
    console.log(`[background-jobs] Advisory lock acquired; scheduled ${this.jobs.length} job group(s)`);
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) this.cancel(timer);
    this.timers.clear();
    const stops = this.stops.splice(0).reverse();
    await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
    if (this.client) {
      try {
        await this.client.query("SELECT pg_advisory_unlock($1)", [BACKGROUND_JOBS_LOCK_ID]);
      } finally {
        this.client.release();
        this.client = null;
      }
    }
    console.log("[background-jobs] Shutdown complete; timers stopped and advisory lock released");
  }
}
