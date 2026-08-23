import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProposalBranding } from "../src/lib/proposalBranding";

const tenant = {
  companyName: "Find And Study",
  publicBrandName: "Find And Study Global",
  companyEmail: "tenant@example.com",
  companyPhone: "+90 212 000 00 00",
  companyWebsite: "https://findandstudy.com",
  logoUrl: "tenant-wide.png",
  logoSquareUrl: "tenant-square.png",
  pdfLogoUrl: "tenant-pdf.png",
};

const agency = {
  companyName: "Agency Company",
  businessName: "Agency Brand",
  email: "agency@example.com",
  phone: "+90 555 000 00 00",
  phoneE164: "+905550000000",
  website: "https://agency.example",
  logoUrl: "agency-own-logo.png",
};

test("tenant users receive tenant PDF branding", () => {
  assert.deepEqual(resolveProposalBranding("super_admin", tenant, agency), {
    logoSrc: "tenant-pdf.png",
    companyName: "Find And Study Global",
    companyEmail: "tenant@example.com",
    companyPhone: "+90 212 000 00 00",
    companyWebsite: "https://findandstudy.com",
  });
});

for (const role of ["agent", "sub_agent", "agent_staff"]) {
  test(`${role} receives the exact agency profile branding`, () => {
    assert.deepEqual(resolveProposalBranding(role, tenant, agency), {
      logoSrc: "agency-own-logo.png",
      companyName: "Agency Brand",
      companyEmail: "agency@example.com",
      companyPhone: "+905550000000",
      companyWebsite: "https://agency.example",
    });
  });
}

test("an agency with an incomplete profile falls back safely to tenant assets", () => {
  assert.deepEqual(resolveProposalBranding("sub_agent", tenant, {}), {
    logoSrc: "tenant-pdf.png",
    companyName: "Find And Study Global",
    companyEmail: "tenant@example.com",
    companyPhone: "+90 212 000 00 00",
    companyWebsite: "https://findandstudy.com",
  });
});

test("tenant contact aliases fill incomplete primary contact fields", () => {
  assert.deepEqual(
    resolveProposalBranding("super_admin", {
      companyName: "White Label",
      supportEmail: "support@example.com",
      whatsappNumber: "+905551112233",
      canonicalBaseUrl: "https://portal.example.com",
    }, undefined),
    {
      logoSrc: null,
      companyName: "White Label",
      companyEmail: "support@example.com",
      companyPhone: "+905551112233",
      companyWebsite: "https://portal.example.com",
    },
  );
});
