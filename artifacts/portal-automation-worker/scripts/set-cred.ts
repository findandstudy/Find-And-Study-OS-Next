import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
const PREFIX = "enc::v1::";
function getKey() {
  const raw = process.env.ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? "";
  if (!raw) throw new Error("ENCRYPTION_KEY/SESSION_SECRET yok");
  return crypto.createHash("sha256").update(raw).digest();
}
function enc(v: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([c.update(v, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}
const portalKey = process.argv[2];
const lines = fs.readFileSync(0, "utf8").split("\n");
const email = (lines[0] || "").trim();
const pass = (lines[1] || "").trim();
if (!portalKey || !email || !pass) { console.error("stdin: 1.satir email, 2.satir parola; arg: portalKey"); process.exit(1); }
await db.execute(sql`UPDATE portal_credentials SET username_enc=${enc(email)}, password_enc=${enc(pass)}, is_active=true, updated_at=now() WHERE portal_key=${portalKey}`);
console.log("OK: " + portalKey + " guncellendi (email " + email.length + " kar, parola " + pass.length + " kar)");
process.exit(0);
