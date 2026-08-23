/**
 * declarativeConfigs.ts — registered declarative adapter configurations.
 *
 * Two export shapes coexist here:
 *
 *   declarativeConfigs  — legacy DeclarativeConfig[] (old API, kept for
 *                          compatibility while adapters are migrated).
 *
 *   declarativeSpecRaws — AdapterSpec-format raw JSON objects (specVersion 1).
 *                          Parsed + compiled at startup in registry.ts via
 *                          parseAdapterSpec + createSpecAdapter.
 *
 * Env-var convention (set in .env / Replit secrets):
 *   <KEY>_EMAIL (or <KEY>_USER) + <KEY>_PASSWORD
 */

import type { DeclarativeConfig } from "./declarativeAdapter.js";

/**
 * Legacy declarative configs (old DeclarativeConfig format).
 * New portals should be added to declarativeSpecRaws below.
 */
export const declarativeConfigs: DeclarativeConfig[] = [
  // Add legacy-format declarative adapters here (if any).
];

/**
 * AdapterSpec-format (specVersion 1) raw objects. Each entry is parsed and
 * compiled into a UniversityAdapter by registry.ts on startup. Invalid specs
 * are skipped with a console.warn.
 */
export const declarativeSpecRaws: readonly unknown[] = [
  // Add specVersion-1 declarative adapters here.
];
