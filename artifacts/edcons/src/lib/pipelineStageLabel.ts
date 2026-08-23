export function humanizePipelineStageKey(value?: string | null): string {
  if (!value) return "";

  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
