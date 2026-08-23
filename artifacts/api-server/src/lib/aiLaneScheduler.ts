export type AiLaneTaskOptions = {
  laneKey: string;
  connectionKey: string;
};

export type AiLaneSchedulerOptions = {
  globalConcurrency: number;
  perLaneConcurrency: number;
  perConnectionConcurrency: number;
  maxQueued: number;
  maxQueuedPerLane: number;
  maxWaitMs: number;
};

type PendingTask<T> = {
  options: AiLaneTaskOptions;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

export class AiLaneQueueError extends Error {
  constructor(
    public readonly code: "AI_QUEUE_FULL" | "AI_LANE_FULL" | "AI_QUEUE_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "AiLaneQueueError";
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Bounded, fair in-process admission queue for document AI calls.
 *
 * Public uploads do not have durable storage references until the application
 * is persisted, so queueing their base64 payloads in PostgreSQL would duplicate
 * sensitive documents and create unbounded database growth. This scheduler
 * keeps the payload only for the lifetime of the HTTP request, while enforcing
 * global, connection and lane budgets. A durable worker can replace it once
 * public uploads are storage-first and jobs can reference object/document IDs.
 */
export class AiLaneScheduler {
  private readonly queues = new Map<string, PendingTask<unknown>[]>();
  private readonly laneOrder: string[] = [];
  private readonly activeByLane = new Map<string, number>();
  private readonly activeByConnection = new Map<string, number>();
  private activeGlobal = 0;
  private queuedTotal = 0;
  private cursor = 0;
  private pumping = false;

  constructor(private readonly config: AiLaneSchedulerOptions) {}

  run<T>(options: AiLaneTaskOptions, work: () => Promise<T>): Promise<T> {
    const laneKey = options.laneKey.trim();
    const connectionKey = options.connectionKey.trim();
    if (!laneKey || !connectionKey) {
      return Promise.reject(new Error("AI lane and connection keys are required"));
    }
    if (this.queuedTotal >= this.config.maxQueued) {
      return Promise.reject(new AiLaneQueueError("AI_QUEUE_FULL", "AI analysis capacity is temporarily full"));
    }
    const queue = this.queues.get(laneKey) ?? [];
    if (queue.length >= this.config.maxQueuedPerLane) {
      return Promise.reject(new AiLaneQueueError("AI_LANE_FULL", "This application channel is temporarily busy"));
    }

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask<T> = {
        options: { laneKey, connectionKey },
        work,
        resolve,
        reject,
        timeout: null,
      };
      task.timeout = setTimeout(() => {
        if (!this.removeQueuedTask(task as PendingTask<unknown>)) return;
        reject(new AiLaneQueueError("AI_QUEUE_TIMEOUT", "AI analysis did not start in time"));
      }, this.config.maxWaitMs);
      task.timeout.unref?.();

      if (!this.queues.has(laneKey)) {
        this.queues.set(laneKey, queue);
        this.laneOrder.push(laneKey);
      }
      queue.push(task as PendingTask<unknown>);
      this.queuedTotal++;
      this.schedulePump();
    });
  }

  snapshot(): {
    active: number;
    queued: number;
    lanes: Record<string, { active: number; queued: number }>;
  } {
    const lanes: Record<string, { active: number; queued: number }> = {};
    for (const lane of new Set([...this.laneOrder, ...this.activeByLane.keys()])) {
      lanes[lane] = {
        active: this.activeByLane.get(lane) ?? 0,
        queued: this.queues.get(lane)?.length ?? 0,
      };
    }
    return { active: this.activeGlobal, queued: this.queuedTotal, lanes };
  }

  private schedulePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeGlobal < this.config.globalConcurrency) {
      const task = this.takeNextRunnable();
      if (!task) return;
      if (task.timeout) clearTimeout(task.timeout);
      const { laneKey, connectionKey } = task.options;
      this.activeGlobal++;
      this.activeByLane.set(laneKey, (this.activeByLane.get(laneKey) ?? 0) + 1);
      this.activeByConnection.set(connectionKey, (this.activeByConnection.get(connectionKey) ?? 0) + 1);

      Promise.resolve()
        .then(task.work)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeGlobal--;
          this.decrement(this.activeByLane, laneKey);
          this.decrement(this.activeByConnection, connectionKey);
          this.schedulePump();
        });
    }
  }

  private takeNextRunnable(): PendingTask<unknown> | null {
    if (this.laneOrder.length === 0) return null;
    for (let checked = 0; checked < this.laneOrder.length; checked++) {
      const index = (this.cursor + checked) % this.laneOrder.length;
      const laneKey = this.laneOrder[index];
      const queue = this.queues.get(laneKey);
      const task = queue?.[0];
      if (!task) continue;
      if ((this.activeByLane.get(laneKey) ?? 0) >= this.config.perLaneConcurrency) continue;
      if ((this.activeByConnection.get(task.options.connectionKey) ?? 0) >= this.config.perConnectionConcurrency) continue;

      queue!.shift();
      this.queuedTotal--;
      this.cursor = (index + 1) % Math.max(1, this.laneOrder.length);
      if (queue!.length === 0) this.removeLane(laneKey);
      return task;
    }
    return null;
  }

  private removeQueuedTask(task: PendingTask<unknown>): boolean {
    const queue = this.queues.get(task.options.laneKey);
    if (!queue) return false;
    const index = queue.indexOf(task);
    if (index < 0) return false;
    queue.splice(index, 1);
    this.queuedTotal--;
    if (queue.length === 0) this.removeLane(task.options.laneKey);
    return true;
  }

  private removeLane(laneKey: string): void {
    this.queues.delete(laneKey);
    const index = this.laneOrder.indexOf(laneKey);
    if (index < 0) return;
    this.laneOrder.splice(index, 1);
    if (this.laneOrder.length === 0) this.cursor = 0;
    else if (index < this.cursor) this.cursor--;
    this.cursor %= Math.max(1, this.laneOrder.length);
  }

  private decrement(map: Map<string, number>, key: string): void {
    const value = (map.get(key) ?? 1) - 1;
    if (value <= 0) map.delete(key);
    else map.set(key, value);
  }
}

export const documentAiScheduler = new AiLaneScheduler({
  globalConcurrency: positiveInt(process.env.AI_DOCUMENT_GLOBAL_CONCURRENCY, 4),
  perLaneConcurrency: positiveInt(process.env.AI_DOCUMENT_LANE_CONCURRENCY, 1),
  perConnectionConcurrency: positiveInt(process.env.AI_DOCUMENT_CONNECTION_CONCURRENCY, 2),
  maxQueued: positiveInt(process.env.AI_DOCUMENT_MAX_QUEUED, 100),
  maxQueuedPerLane: positiveInt(process.env.AI_DOCUMENT_MAX_QUEUED_PER_LANE, 20),
  maxWaitMs: positiveInt(process.env.AI_DOCUMENT_MAX_WAIT_MS, 10_000),
});
