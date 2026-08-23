#!/usr/bin/env node
/**
 * Prod→Dev data loader
 * Reads JSON files from /tmp/prodcopy/<table>.json and loads them into dev DB.
 * Run with: node scripts/prod-to-dev-loader.js
 */
const { Client } = require('/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg');
const fs = require('fs');
const path = require('path');

const COPY_DIR = '/tmp/prodcopy';
const BATCH_SIZE = 500;

// Insertion order: parents before children (FK safe even without replica role)
const TABLE_ORDER = [
  // Reference / lookup tables first
  'roles','countries','cities','destinations','universities',
  'catalog_options','pipeline_stages','pipeline_migrations',
  'degree_document_requirements','program_document_requirements',
  'programs','settings','system_flags','system_kv',
  'notification_rules','website_theme_tokens',
  'website_navigation_menus','website_navigation_items',
  'website_pages','website_page_versions','website_page_blocks',
  'website_global_components','website_collections_faqs',
  'website_collections_offices','website_collections_team_members',
  'website_collections_testimonials','website_forms','website_form_fields',
  'website_form_submissions','website_blog_categories','website_blog_tags',
  'website_blog_posts','website_blog_post_tags',
  'blog_posts','quick_links','announcements','tasks',
  // Users & agents
  'branches','users','agents','agent_branches','agency_assigned_staff',
  'staff_languages','staff_work_schedules','staff_salary_payments','staff_documents',
  // Leads, contacts, channels
  'external_contacts','channel_accounts','leads','lead_assignment_rules',
  'follow_ups',
  // Students
  'students',
  // Applications
  'applications',
  // Conversations
  'conversations','conversation_participants','messages',
  'message_templates','broadcasts','campaigns',
  // Documents
  'documents','application_stage_documents',
  // Finance
  'commissions','service_fees','staff_commissions','staff_commission_payouts',
  'invoices','financial_transactions',
  // Contracts
  'contract_templates','signing_sessions','signed_contracts',
  'university_contracts',
  // Notifications & activity
  'notifications','entity_view_events',
  'popup_dismissals','popups',
  // Portal
  'portal_adapters','portal_automation_settings','portal_credentials',
  'portal_program_mapping','portal_submissions','portal_universities',
  // AI
  'ai_extractors','ai_extractor_runs','ai_personas','ai_persona_runs','ai_persona_messages',
  'ai_action_queue','ai_default_configs',
  // Misc
  'api_tokens','integrations','embed_widgets','embed_submissions',
  'object_owners','object_owners_backfill',
  'audit_logs','email_queue','notes',
  'wishlists','rate_limits',
  'staff_commission_payouts','staff_commissions',
];

// Tables that have an 'id' column (serial) to reset the sequence for
const TABLES_WITH_ID_SEQ = new Set([
  'agency_assigned_staff','agent_branches','agents','ai_action_queue','ai_default_configs',
  'ai_extractor_runs','ai_extractors','ai_persona_messages','ai_persona_runs','ai_personas',
  'announcements','api_tokens','application_stage_documents','applications','audit_logs',
  'blog_posts','branches','broadcasts','campaigns','catalog_options','channel_accounts',
  'cities','commissions','contract_templates','conversation_participants','conversations',
  'countries','degree_document_requirements','destinations','documents','email_queue',
  'embed_submissions','embed_widgets','entity_view_events','external_contacts',
  'financial_transactions','follow_ups','integrations','invoices','lead_assignment_rules',
  'leads','message_templates','messages','notes','notification_rules','notifications',
  'object_owners','object_owners_backfill','pipeline_migrations','pipeline_stages',
  'popup_dismissals','popups','portal_adapters','portal_automation_settings',
  'portal_credentials','portal_program_mapping','portal_submissions','portal_universities',
  'program_document_requirements','programs','quick_links','service_fees',
  'signed_contracts','signing_sessions','staff_commission_payouts','staff_commissions',
  'staff_documents','staff_languages','staff_salary_payments','staff_work_schedules',
  'students','tasks','universities','university_contracts','users',
  'website_blog_categories','website_blog_post_tags','website_blog_posts','website_blog_tags',
  'website_collections_faqs','website_collections_offices','website_collections_team_members',
  'website_collections_testimonials','website_form_fields','website_form_submissions',
  'website_forms','website_global_components','website_navigation_items',
  'website_navigation_menus','website_page_blocks','website_page_versions','website_pages',
  'wishlists',
]);

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('[loader] Connected to dev DB');

  try {
    // Step 1: Truncate ALL tables with replica role (skips FK checks)
    console.log('[loader] Truncating all dev tables...');
    await client.query('SET session_replication_role = replica');

    // Get all user table names in dev
    const tablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);

    for (const t of allTables) {
      try {
        await client.query(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`);
      } catch (e) {
        console.warn(`[loader] TRUNCATE ${t} warning: ${e.message}`);
      }
    }
    console.log(`[loader] Truncated ${allTables.length} tables`);

    // Step 2: Insert in dependency order
    const files = fs.readdirSync(COPY_DIR).filter(f => f.endsWith('.json'));
    const availableTables = new Set(files.map(f => f.replace('.json', '')));

    // Build ordered list: TABLE_ORDER first, then any remaining
    const ordered = [...TABLE_ORDER.filter(t => availableTables.has(t))];
    for (const t of availableTables) {
      if (!TABLE_ORDER.includes(t)) ordered.push(t);
    }

    let totalInserted = 0;
    for (const table of ordered) {
      const filePath = path.join(COPY_DIR, `${table}.json`);
      if (!fs.existsSync(filePath)) continue;

      const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!rows.length) {
        console.log(`[loader] ${table}: 0 rows (skipped)`);
        continue;
      }

      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        try {
          const res = await client.query(
            `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json) ON CONFLICT DO NOTHING`,
            [JSON.stringify(batch)]
          );
          inserted += res.rowCount || 0;
        } catch (e) {
          console.error(`[loader] ERROR inserting into ${table} batch ${i}-${i+BATCH_SIZE}: ${e.message}`);
        }
      }
      totalInserted += inserted;
      console.log(`[loader] ${table}: ${inserted}/${rows.length} rows inserted`);

      // Reset sequence if table has id column
      if (TABLES_WITH_ID_SEQ.has(table)) {
        try {
          await client.query(`
            SELECT setval(
              pg_get_serial_sequence('public."${table}"', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM "${table}"), 1)
            )
          `);
        } catch (_) { /* table may not have id sequence */ }
      }
    }

    await client.query('SET session_replication_role = DEFAULT');
    console.log(`\n[loader] Done! Total rows inserted: ${totalInserted}`);
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[loader] FATAL:', e); process.exit(1); });
