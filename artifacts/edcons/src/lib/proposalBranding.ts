export type ProposalBrandingSettings = {
  companyName?: string;
  publicBrandName?: string;
  companyEmail?: string;
  supportEmail?: string;
  salesEmail?: string;
  companyPhone?: string;
  whatsappNumber?: string;
  companyWebsite?: string;
  canonicalBaseUrl?: string;
  logoUrl?: string | null;
  logoSquareUrl?: string | null;
  pdfLogoUrl?: string | null;
};

export type ProposalAgencyProfile = {
  logoUrl?: string | null;
  companyName?: string;
  businessName?: string;
  email?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  website?: string | null;
};

export type ProposalBranding = {
  logoSrc: string | null;
  companyName: string;
  companyEmail?: string;
  companyPhone?: string;
  companyWebsite?: string;
};

/**
 * Keep proposal ownership explicit:
 * - tenant roles use tenant PDF branding;
 * - agent and sub-agent roles use their own /agents/me record;
 * - agent staff use the managing agency record returned by /agents/me.
 *
 * Tenant branding is only a safe fallback when an agency has not uploaded a
 * particular asset or contact value. A sub-agent never inherits the parent
 * agency's logo through this resolver.
 */
export function resolveProposalBranding(
  role: string | undefined,
  settings: ProposalBrandingSettings | undefined,
  agency: ProposalAgencyProfile | undefined,
): ProposalBranding {
  const agencySide = role === "agent" || role === "sub_agent" || role === "agent_staff";
  const tenantLogo = settings?.pdfLogoUrl || settings?.logoSquareUrl || settings?.logoUrl || null;
  const tenantEmail =
    settings?.companyEmail || settings?.salesEmail || settings?.supportEmail || undefined;
  const tenantPhone = settings?.companyPhone || settings?.whatsappNumber || undefined;
  const tenantWebsite = settings?.companyWebsite || settings?.canonicalBaseUrl || undefined;

  if (!agencySide) {
    return {
      logoSrc: tenantLogo,
      companyName: settings?.publicBrandName || settings?.companyName || "Find And Study",
      companyEmail: tenantEmail,
      companyPhone: tenantPhone,
      companyWebsite: tenantWebsite,
    };
  }

  return {
    logoSrc: agency?.logoUrl || tenantLogo,
    companyName:
      agency?.businessName ||
      agency?.companyName ||
      settings?.publicBrandName ||
      settings?.companyName ||
      "Find And Study",
    companyEmail: agency?.email || tenantEmail,
    companyPhone: agency?.phoneE164 || agency?.phone || tenantPhone,
    companyWebsite: agency?.website || tenantWebsite,
  };
}
