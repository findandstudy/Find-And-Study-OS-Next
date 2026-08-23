process.env.SF_DRYRUN = "1";
process.env.PORTAL_DRYRUN = "1";
import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";

const KEYS = (process.env.KEYS || "uskudar,bau,sabanci,yeditepe,ozyegin,atlas,emu,united,sit").split(",");
const stamp = Date.now().toString().slice(-7);

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + tag)), ms))]);
}

(async () => {
  for (const key of KEYS) {
    const t0 = Date.now();
    const line: any = { key };
    let session: any = null;
    try {
      const adapter: any = adapterByKey(key);
      if (!adapter) { line.error = "no adapter"; console.log("DRY " + JSON.stringify(line)); continue; }
      const creds = await resolvePortalCreds(key, key);
      const profile: any = {
        firstName: "Mehmet", lastName: "Yilmaz",
        email: "fas.dry." + key + stamp + "@example.com",
        passportNumber: "FAS" + key.slice(0,2).toUpperCase() + stamp,
        dateOfBirth: "1995-01-01", gender: "Male", nationality: "Turkey",
        phone: "5321112233", address: "Istanbul", city: "Istanbul",
        programName: "", programId: "", level: "Bachelor",
        lastSchool: "Test High School", gpa: "3.5",
        universityName: adapter.label,
      };
      const files: any = { passport: "/tmp/dummy.pdf", transcript: "/tmp/dummy.pdf", diploma: "/tmp/dummy.pdf", photo: "/tmp/dummy.jpg" };
      session = await withTimeout(adapter.login({ credentials: creds, headless: true }), 90000, "login");
      line.loginOk = true;
      const res = await withTimeout(adapter.submit(session, profile, files), 160000, "submit");
      line.res = res;
    } catch (e: any) { line.error = e.message; }
    finally { try { if (session) await session.close(); } catch (e) {} }
    line.secs = Math.round((Date.now() - t0) / 1000);
    console.log("DRY " + JSON.stringify(line));
  }
  console.log("ALL DONE");
  process.exit(0);
})();
