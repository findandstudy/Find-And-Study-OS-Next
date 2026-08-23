/**
 * Detects the server-side "non-Latin name" rejection (Job C). The API returns a
 * 400 whose `error` string is prefixed with `NON_LATIN_NAME:<field>:` when a name
 * contains a non-Latin-script letter (Arabic, Cyrillic, CJK, etc.). Frontends use
 * this to show the localized `common.latinOnlyName` message instead of the raw code.
 */
export function isNonLatinNameError(err: unknown): boolean {
  const anyErr = err as { data?: { error?: unknown }; message?: unknown } | null | undefined;
  const fromData = anyErr?.data?.error;
  const fromMsg = anyErr?.message;
  const haystack = [fromData, fromMsg]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return haystack.includes("NON_LATIN_NAME");
}
