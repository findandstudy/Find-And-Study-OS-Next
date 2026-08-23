export type LeadSourceOption = {
  value: string;
  label: string;
  kind?: "lead_form" | "embed" | "other";
};

export const DEFAULT_LEAD_SOURCE_OPTIONS: LeadSourceOption[] = [
  { value: "website", label: "website", kind: "other" },
  { value: "referral", label: "referral", kind: "other" },
  { value: "social_media", label: "social media", kind: "other" },
  { value: "walk_in", label: "walk in", kind: "other" },
  { value: "partner", label: "partner", kind: "other" },
  { value: "other", label: "other", kind: "other" },
];

function fallbackLabel(value: string): string {
  return value.replace(/_/g, " ");
}

export function buildLeadSourceFilterOptions(
  apiOptions: LeadSourceOption[] | null | undefined,
  selectedValue = "all",
): LeadSourceOption[] {
  const candidates = apiOptions?.length ? apiOptions : DEFAULT_LEAD_SOURCE_OPTIONS;
  const byValue = new Map<string, LeadSourceOption>();

  for (const option of candidates) {
    const value = option?.value?.trim();
    if (!value || value === "all" || byValue.has(value)) continue;
    byValue.set(value, {
      ...option,
      value,
      label: option.label?.trim() || fallbackLabel(value),
    });
  }

  const selected = selectedValue.trim();
  if (selected && selected !== "all" && !byValue.has(selected)) {
    byValue.set(selected, { value: selected, label: fallbackLabel(selected), kind: "other" });
  }

  return [...byValue.values()];
}
