/**
 * SEC-001 — SSRF isValidHttpUrl doğrulama testi
 * Bağımsız olarak çalışır, hiçbir dış bağımlılık yoktur.
 * Çalıştır: node artifacts/api-server/scripts/validate-sec001-ssrf.mjs
 */

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Strip IPv6 brackets: new URL('http://[::1]/').hostname === '[::1]'
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^fc[0-9a-f]{2}:/i.test(host) ||
      /^fd[0-9a-f]{2}:/i.test(host)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

const CASES = [
  // ── NEGATİF (reddedilmeli → false) ──────────────────────────────────────
  { url: "http://localhost/evil",               expect: false, label: "localhost" },
  { url: "http://localhost:8080/secret",        expect: false, label: "localhost:8080" },
  { url: "http://127.0.0.1/etc/passwd",         expect: false, label: "127.0.0.1 (loopback)" },
  { url: "http://127.255.255.255/test",         expect: false, label: "127.255.255.255 (loopback alt aralık)" },
  { url: "http://10.0.0.1/internal",            expect: false, label: "10.0.0.1 (RFC-1918 /8)" },
  { url: "http://10.255.255.254/api",           expect: false, label: "10.255.255.254 (RFC-1918 /8 uç)" },
  { url: "http://192.168.1.1/router",           expect: false, label: "192.168.1.1 (RFC-1918 /16)" },
  { url: "http://192.168.0.100/secret",         expect: false, label: "192.168.0.100 (RFC-1918 /16)" },
  { url: "http://172.16.0.1/priv",              expect: false, label: "172.16.0.1 (RFC-1918 /12 başlangıç)" },
  { url: "http://172.20.5.3/priv",              expect: false, label: "172.20.5.3 (RFC-1918 /12 orta)" },
  { url: "http://172.31.255.255/priv",          expect: false, label: "172.31.255.255 (RFC-1918 /12 son)" },
  { url: "http://169.254.0.1/metadata",         expect: false, label: "169.254.0.1 (link-local/AWS metadata)" },
  { url: "http://169.254.169.254/latest",       expect: false, label: "169.254.169.254 (AWS IMDSv1)" },
  { url: "http://[::1]/loopback",               expect: false, label: "::1 (IPv6 loopback)" },
  { url: "http://0.0.0.0/wildcard",             expect: false, label: "0.0.0.0 (wildcard bind)" },
  { url: "http://foo.localhost/test",            expect: false, label: "*.localhost subdomain" },
  { url: "ftp://example.com/file",              expect: false, label: "ftp:// protokolü" },
  { url: "file:///etc/passwd",                  expect: false, label: "file:// protokolü" },
  { url: "not-a-url",                           expect: false, label: "geçersiz URL" },
  { url: "",                                    expect: false, label: "boş string" },
  // ── POZİTİF (kabul edilmeli → true) ──────────────────────────────────────
  { url: "https://example.com/file.pdf",        expect: true,  label: "public HTTPS domain" },
  { url: "http://example.com/file.pdf",         expect: true,  label: "public HTTP domain" },
  { url: "https://storage.googleapis.com/b/o",  expect: true,  label: "Google Cloud Storage" },
  { url: "https://s3.amazonaws.com/b/k",        expect: true,  label: "AWS S3 public endpoint" },
  { url: "https://172.32.0.1/public",           expect: true,  label: "172.32.x (RFC-1918 /12 DIŞINDA)" },
  { url: "https://172.15.0.1/public",           expect: true,  label: "172.15.x (RFC-1918 /12 ALTINDA)" },
  { url: "https://1.1.1.1/dns",                 expect: true,  label: "Cloudflare DNS (public IP)" },
  { url: "https://8.8.8.8/resolve",             expect: true,  label: "Google DNS (public IP)" },
];

let passed = 0;
let failed = 0;
const failures = [];

for (const { url, expect, label } of CASES) {
  const got = isValidHttpUrl(url);
  const ok = got === expect;
  if (ok) {
    passed++;
    console.log(`  ✅ PASS  [${expect ? "ALLOW" : "BLOCK"}]  ${label}`);
  } else {
    failed++;
    failures.push({ label, url, expect, got });
    console.log(`  ❌ FAIL  [expected=${expect ? "ALLOW" : "BLOCK"}, got=${got ? "ALLOW" : "BLOCK"}]  ${label}  →  ${url}`);
  }
}

console.log(`\n── SEC-001 SSRF: ${passed}/${CASES.length} PASS, ${failed} FAIL ──`);
if (failed > 0) {
  console.log("\nBaşarısız durumlar:");
  for (const f of failures) {
    console.log(`  ${f.label}: beklenen=${f.expect}, alınan=${f.got}  url=${f.url}`);
  }
  process.exit(1);
}
process.exit(0);
