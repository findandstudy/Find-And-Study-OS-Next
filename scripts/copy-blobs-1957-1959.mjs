import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js');

const DEV_URL = process.env.DATABASE_URL;
if (!DEV_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

// Doc IDs and their dev counterparts (need to find dev doc IDs)
// prod doc IDs for apps 1957, 1959
const PROD_DOC_IDS = [3852, 3853, 3854, 3855, 3860, 3861, 3862, 3863];
const CHUNK = 100_000;

async function readProdBlob(docId) {
  const { executeSql } = await import('/home/runner/workspace/.local/skills/database/executeSql.mjs').catch(() => null) || {};
  // Use base64 chunked read from prod via executeSql by running a sub-process
  return null; // placeholder — we'll use the helper below
}

// We'll use psql-like approach: read prod via exec + write to dev via pg
import { execSync } from 'child_process';

async function getProdDocBase64(docId) {
  // Get total length first
  const lenResult = execSync(
    `node -e "
const fetch = require('/home/runner/workspace/node_modules/.pnpm/node-fetch@2.7.0/node_modules/node-fetch/lib/index.js');
"`,
    { env: process.env }
  ).toString().trim();
}

// Actually let's use the correct approach: read via the executeSql tool proxy
// We'll shell out to node for each chunk read

const devClient = new Client({ connectionString: DEV_URL });
await devClient.connect();
await devClient.query('SET session_replication_role = replica');

// First find dev doc IDs matching prod doc IDs (same application_id + type)
const prodDocMeta = [
  { id: 3852, app_id: 1957, type: 'high_school_diploma_translation' },
  { id: 3853, app_id: 1957, type: 'class_12th_hsc_marks_sheet' },
  { id: 3854, app_id: 1957, type: 'passport' },
  { id: 3855, app_id: 1957, type: 'photo' },
  { id: 3860, app_id: 1959, type: 'high_school_diploma_translation' },
  { id: 3861, app_id: 1959, type: 'class_12th_hsc_marks_sheet' },
  { id: 3862, app_id: 1959, type: 'passport' },
  { id: 3863, app_id: 1959, type: 'photo' },
];

// Find dev doc IDs
console.log('Finding dev document IDs...');
for (const doc of prodDocMeta) {
  const res = await devClient.query(
    `SELECT id FROM documents WHERE application_id = $1 AND type = $2 LIMIT 1`,
    [doc.app_id, doc.type]
  );
  if (res.rows.length === 0) {
    console.error(`  ❌ Dev doc not found: app=${doc.app_id} type=${doc.type}`);
    doc.devId = null;
  } else {
    doc.devId = res.rows[0].id;
    console.log(`  ✓ prod ${doc.id} → dev ${doc.devId} (app=${doc.app_id} ${doc.type})`);
  }
}

await devClient.end();

console.log('\nDone mapping. Now copy blobs via copy-blobs-worker.mjs');
console.log('Doc map:');
console.log(JSON.stringify(prodDocMeta, null, 2));
