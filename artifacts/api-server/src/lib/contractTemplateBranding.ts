import { contractBrandProfilesTable, contractTemplatesTable, db } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  sanitizeContractBranding,
  type ContractBrandingConfig,
} from "./contractBranding";

/**
 * Resolves the immutable branding snapshot used by a signing session.
 *
 * A template may inherit its branding from a centrally managed brand profile
 * and may optionally override individual fields with its legacy, template-level
 * configuration. Keeping this resolution in one place prevents onboarding and
 * manually created contracts from producing different PDFs.
 */
export async function resolveContractTemplateBranding(
  template: typeof contractTemplatesTable.$inferSelect,
): Promise<ContractBrandingConfig | null> {
  let profileConfig: ContractBrandingConfig | null = null;

  if (template.brandProfileId) {
    const [profile] = await db
      .select({ config: contractBrandProfilesTable.config })
      .from(contractBrandProfilesTable)
      .where(and(
        eq(contractBrandProfilesTable.id, template.brandProfileId),
        eq(contractBrandProfilesTable.isActive, true),
      ));
    profileConfig = sanitizeContractBranding(profile?.config);
  }

  const templateConfig = sanitizeContractBranding(template.signingPageConfig);
  return sanitizeContractBranding({
    ...(profileConfig || {}),
    ...(templateConfig || {}),
  });
}
