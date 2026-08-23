// Pool type from pg — resolved via actual usage (pool.query)

/**
 * Seed the master list of currencies into `catalog_options` under
 * category="currency". Idempotent per-row. Each row stores:
 *   - value: ISO 4217 code (USD, EUR, ...)
 *   - metadata: { label, symbol } for display
 *
 * Admins can add/remove currencies from Catalog → Options → Currencies.
 * Newly added codes show up in the program currency dropdown and
 * /api/currencies-in-use immediately (used by the Finance dashboard).
 */
type CurrencySeed = { code: string; label: string; symbol: string };

const CURRENCIES: CurrencySeed[] = [
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "TRY", label: "Turkish Lira", symbol: "₺" },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ" },
];

export async function seedCurrencies(pool: { query: (...args: any[]) => Promise<any> }): Promise<void> {
  try {
    // Race-safe uniqueness — relies on the index seedDocumentTypes also
    // creates. Create here too in case currencies are seeded standalone.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_options_category_value_uq
      ON catalog_options (category, value)
    `);

    let touched = 0;
    for (let i = 0; i < CURRENCIES.length; i++) {
      const { code, label, symbol } = CURRENCIES[i];
      const metadata = { label, symbol };
      const res = await pool.query(
        `INSERT INTO catalog_options (category, value, sort_order, is_active, metadata)
         VALUES ('currency', $1, $2, true, $3::jsonb)
         ON CONFLICT (category, value) DO UPDATE
           SET metadata = COALESCE(catalog_options.metadata, EXCLUDED.metadata)`,
        [code, i, JSON.stringify(metadata)],
      );
      if (res.rowCount && res.rowCount > 0) touched++;
    }
    if (touched > 0) {
      console.log(`[seed] Currencies: ${touched} rows upserted`);
    }
  } catch (err) {
    console.error("[seed] seedCurrencies error:", err);
  }
}
