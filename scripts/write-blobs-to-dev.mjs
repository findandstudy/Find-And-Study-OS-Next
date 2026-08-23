import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { Client } = require('/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js');

const DEV_URL = process.env.DATABASE_URL;
if (!DEV_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const blobs = JSON.parse(readFileSync('/tmp/blobs-1957-1959.json', 'utf8'));

const client = new Client({ connectionString: DEV_URL });
await client.connect();

let ok = 0, fail = 0;
for (const [docIdStr, b64] of Object.entries(blobs)) {
  const docId = Number(docIdStr);
  try {
    const res = await client.query(
      `UPDATE documents SET file_data = $1 WHERE id = $2`,
      [b64, docId]
    );
    if (res.rowCount === 1) {
      console.log(`✓ doc ${docId} — ${Math.round(b64.length / 1024)}KB written`);
      ok++;
    } else {
      console.warn(`⚠ doc ${docId} — rowCount=${res.rowCount} (not found?)`);
      fail++;
    }
  } catch (e) {
    console.error(`✗ doc ${docId} — ${e.message}`);
    fail++;
  }
}

await client.end();
console.log(`\nDone: ${ok} ok, ${fail} fail`);
