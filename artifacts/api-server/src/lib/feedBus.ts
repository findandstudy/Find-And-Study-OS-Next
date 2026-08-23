import { EventEmitter } from "events";
import { pool } from "@workspace/db";

export interface FeedBusEvent {
  personKeys: string[];
  action: "note_added" | "note_deleted" | "followup_added" | "followup_updated";
  itemId: number;
}

const CHANNEL = "feed_events";
const RECONNECT_DELAY_MS = 1_000;

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listenClient: any = null;
let connecting: Promise<void> | null = null;
let isShuttingDown = false;

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  setTimeout(() => {
    connectListenClient().catch((err) => {
      console.error("[feedBus] reconnect failed, will retry", err);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function connectListenClient(): Promise<void> {
  if (listenClient) return;
  if (connecting) return connecting;
  connecting = (async (): Promise<void> => {
    try {
      const client = await pool.connect();

      const handleNotification = (msg: { channel: string; payload?: string }) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          const event = JSON.parse(msg.payload) as FeedBusEvent;
          localEmitter.emit("feed", event);
        } catch (err) {
          console.error("[feedBus] failed to parse notification payload", err);
        }
      };

      const handleError = (err: Error) => {
        console.error("[feedBus] LISTEN client error, reconnecting", err);
        try {
          client.removeListener("notification", handleNotification);
          client.removeListener("error", handleError);
          client.release(true);
        } catch {
          // ignore release errors
        }
        listenClient = null;
        scheduleReconnect();
      };

      client.on("notification", handleNotification);
      client.on("error", handleError);
      await client.query(`LISTEN ${CHANNEL}`);
      listenClient = client;
      console.log("[feedBus] LISTEN connection established");
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

// Eagerly start the LISTEN connection on module load.
void connectListenClient().catch((err) => {
  console.error("[feedBus] initial LISTEN failed, will retry", err);
  scheduleReconnect();
});

export const feedBus = {
  /**
   * Publish an event via pg_notify. The payload must fit within Postgres'
   * NOTIFY limit (~8 KB). Our payload is at most a handful of bytes:
   *   {"personKeys":["lead_12345","student_67890"],"action":"note_added","itemId":999}
   */
  publish(event: FeedBusEvent): void {
    const payload = JSON.stringify(event);
    pool
      .query("SELECT pg_notify($1, $2)", [CHANNEL, payload])
      .catch((err: unknown) => {
        console.error("[feedBus] publish failed", err);
      });
  },

  /**
   * Subscribe to feed events. Returns an unsubscribe function.
   * The LISTEN client is started lazily on first subscribe but is also
   * started eagerly at module load, so there is effectively no delay.
   */
  subscribe(handler: (event: FeedBusEvent) => void): () => void {
    void connectListenClient().catch(() => {
      // already logged above
    });
    localEmitter.on("feed", handler);
    return () => {
      localEmitter.off("feed", handler);
    };
  },

  /**
   * Gracefully release the LISTEN connection. Call on SIGTERM / SIGINT.
   */
  async shutdown(): Promise<void> {
    isShuttingDown = true;
    const client = listenClient;
    listenClient = null;
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${CHANNEL}`);
      client.release();
      console.log("[feedBus] LISTEN connection released");
    } catch {
      try { client.release(true); } catch { /* ignore */ }
    }
  },
};

export function personKeys(leadId: number | null, studentId: number | null): string[] {
  const keys: string[] = [];
  if (leadId) keys.push(`lead_${leadId}`);
  if (studentId) keys.push(`student_${studentId}`);
  return keys;
}
