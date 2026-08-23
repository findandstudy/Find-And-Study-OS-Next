import { EventEmitter } from "events";
import { pool } from "@workspace/db";

export interface NotificationBusEvent {
  userId: number;
  notificationId?: number;
  type: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  priority?: "critical" | "high" | "normal";
}

const CHANNEL = "notification_events";
const RECONNECT_DELAY_MS = 1000;

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(0);

let listenClient: any = null;
let connecting: Promise<void> | null = null;

function scheduleReconnect(): void {
  setTimeout(() => {
    connectListenClient().catch((err) => {
      console.error("[notificationBus] reconnect failed, will retry", err);
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
          const event = JSON.parse(msg.payload) as NotificationBusEvent;
          localEmitter.emit("event", event);
        } catch (err) {
          console.error("[notificationBus] failed to parse notification", err);
        }
      };
      const handleError = (err: Error) => {
        console.error("[notificationBus] LISTEN client error, reconnecting", err);
        try {
          client.removeListener("notification", handleNotification);
          client.removeListener("error", handleError);
          client.release(true);
        } catch {
          // ignore
        }
        listenClient = null;
        scheduleReconnect();
      };
      client.on("notification", handleNotification);
      client.on("error", handleError);
      try {
        await client.query(`LISTEN ${CHANNEL}`);
      } catch (err) {
        // Release the client back to the pool if LISTEN itself fails,
        // otherwise repeated failures would leak pool connections.
        client.removeListener("notification", handleNotification);
        client.removeListener("error", handleError);
        try {
          client.release(true);
        } catch {
          // ignore
        }
        throw err;
      }
      listenClient = client;
      return;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export const notificationBus = {
  subscribe(handler: (event: NotificationBusEvent) => void): () => void {
    void connectListenClient().catch((err) => {
      console.error("[notificationBus] initial LISTEN failed, will retry", err);
      scheduleReconnect();
    });
    localEmitter.on("event", handler);
    return () => {
      localEmitter.off("event", handler);
    };
  },
  publish(event: NotificationBusEvent): void {
    const payload = JSON.stringify(event);
    pool
      .query("SELECT pg_notify($1, $2)", [CHANNEL, payload])
      .catch((err: unknown) => {
        console.error("[notificationBus] publish failed", err);
      });
  },
};
