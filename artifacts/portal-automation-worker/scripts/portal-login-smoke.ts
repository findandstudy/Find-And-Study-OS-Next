import {
  clearCredsOverride,
  resolveAdapterByKey,
  setCredsOverride,
} from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";

const ALLOWED = new Set(["united", "multico", "okan", "uskudar", "beykent", "isik", "altinbas"]);
const keys = process.argv.slice(2);

if (keys.length === 0 || keys.some((key) => !ALLOWED.has(key))) {
  console.error("Usage: pnpm smoke:portal-login united multico okan uskudar beykent isik altinbas");
  process.exit(2);
}

let failures = 0;
for (const key of keys) {
  let session: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof resolveAdapterByKey>>>["login"]>> | null = null;
  try {
    const adapter = await resolveAdapterByKey(key);
    if (!adapter) throw new Error("adapter not found");
    const creds = await resolvePortalCreds(key, adapter.key);
    setCredsOverride(adapter.key, creds);
    session = await adapter.login({ headless: true, credentials: creds });
    const url = session.page.url();
    const title = await session.page.title().catch(() => "");
    console.log(`SMOKE ${key} OK url=${JSON.stringify(url)} title=${JSON.stringify(title)}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SMOKE ${key} FAIL ${message.replace(/\s+/g, " ").slice(0, 240)}`);
  } finally {
    await session?.close().catch(() => {});
    clearCredsOverride(key);
  }
}

process.exitCode = failures === 0 ? 0 : 1;
