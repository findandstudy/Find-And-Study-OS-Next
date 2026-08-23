/**
 * SEC-003 — XSS DOMPurify sanitization doğrulama testi
 * isomorphic-dompurify'nin server-side davranışını doğrular.
 * Çalıştır: node artifacts/api-server/scripts/validate-sec003-xss.mjs
 */

import DOMPurify from "isomorphic-dompurify";

const CASES = [
  // ── XSS enjeksiyonları — sanitize sonrası temizlenmeli ───────────────────
  {
    label: "<script> etiketi",
    input: '<p>Sözleşme</p><script>alert("xss")</script>',
    mustNotContain: ["<script>", "alert("],
    mustContain: ["Sözleşme"],
  },
  {
    label: "onerror event handler",
    input: '<img src=x onerror="alert(1)">',
    mustNotContain: ["onerror"],
    mustContain: [],
  },
  {
    label: "javascript: href",
    input: '<a href="javascript:alert(1)">tıkla</a>',
    mustNotContain: ["javascript:"],
    mustContain: [],
  },
  {
    label: "svg/onload",
    input: '<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>',
    mustNotContain: ["onbegin", "alert"],
    mustContain: [],
  },
  {
    label: "data: URI script",
    input: '<object data="data:text/html,<script>alert(1)</script>"></object>',
    mustNotContain: ["data:text/html"],
    mustContain: [],
  },
  {
    label: "iframe enjeksiyonu",
    input: '<iframe src="https://evil.com"></iframe>',
    mustNotContain: ["iframe"],
    mustContain: [],
  },
  {
    label: "onclick handler",
    input: '<div onclick="stealCookies()">İçerik</div>',
    mustNotContain: ["onclick"],
    mustContain: ["İçerik"],
  },
  {
    label: "style/expression (IE eski)",
    input: '<p style="width:expression(alert(1))">test</p>',
    mustNotContain: ["expression("],
    mustContain: ["test"],
  },
  // ── Meşru HTML — korunmalı ───────────────────────────────────────────────
  {
    label: "meşru paragraf ve bold",
    input: "<p>Bu bir <strong>sözleşme</strong> metnidir.</p>",
    mustNotContain: [],
    mustContain: ["<p>", "<strong>", "sözleşme"],
  },
  {
    label: "meşru liste",
    input: "<ul><li>Madde 1</li><li>Madde 2</li></ul>",
    mustNotContain: [],
    mustContain: ["<ul>", "<li>"],
  },
  {
    label: "meşru başlık",
    input: "<h2>Sözleşme Şartları</h2><p>Metin burada.</p>",
    mustNotContain: [],
    mustContain: ["<h2>", "Sözleşme Şartları"],
  },
];

let passed = 0;
let failed = 0;

console.log("");
console.log("═══════════════════════════════════════════════════════════");
console.log(" SEC-003 — XSS DOMPurify Sanitization Doğrulama Testi");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log("Kod yolu doğrulaması:");
console.log("  SignFlow.tsx     satır 494: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }}");
console.log("  SignContract.tsx satır 300: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.previewHtml || \"\") }}");
console.log("");

for (const { label, input, mustNotContain, mustContain } of CASES) {
  const sanitized = DOMPurify.sanitize(input);
  let ok = true;
  const problems = [];

  for (const bad of mustNotContain) {
    if (sanitized.includes(bad)) {
      ok = false;
      problems.push(`"${bad}" hâlâ mevcut!`);
    }
  }
  for (const good of mustContain) {
    if (!sanitized.includes(good)) {
      ok = false;
      problems.push(`"${good}" kayboldu!`);
    }
  }

  if (ok) {
    passed++;
    console.log(`  ✅ PASS  ${label}`);
    console.log(`         girdi:   ${input.slice(0, 80)}`);
    console.log(`         çıktı:   ${sanitized.slice(0, 80) || "(boş — script/iframe kaldırıldı)"}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${label}`);
    console.log(`         girdi:   ${input}`);
    console.log(`         çıktı:   ${sanitized}`);
    for (const p of problems) console.log(`         sorun:   ${p}`);
  }
  console.log("");
}

console.log(`── SEC-003 XSS: ${passed}/${CASES.length} PASS, ${failed} FAIL ──`);
process.exit(failed > 0 ? 1 : 0);
