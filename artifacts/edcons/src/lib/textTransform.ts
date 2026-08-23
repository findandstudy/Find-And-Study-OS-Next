const TR_TO_LATIN_MAP: Record<string, string> = {
  // Turkish
  "ç": "c", "Ç": "C",
  "ğ": "g", "Ğ": "G",
  "ı": "i", "İ": "I",
  "ö": "o", "Ö": "O",
  "ş": "s", "Ş": "S",
  "ü": "u", "Ü": "U",
  "â": "a", "Â": "A",
  "î": "i", "Î": "I",
  "û": "u", "Û": "U",
  // Azerbaijani (schwa — does NOT decompose via NFD)
  "ə": "e", "Ə": "E",
  // Nordic / Germanic / Celtic
  "ø": "o", "Ø": "O",
  "ß": "ss",
  "æ": "ae", "Æ": "AE",
  "œ": "oe", "Œ": "OE",
  "ð": "d", "Ð": "D",
  "þ": "th", "Þ": "Th",
  // Slavic / Baltic
  "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L",
};

function transliterate(input: string): string {
  let out = "";
  for (const ch of input) {
    if (TR_TO_LATIN_MAP[ch] !== undefined) {
      out += TR_TO_LATIN_MAP[ch];
      continue;
    }
    const normalized = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += normalized;
  }
  // Safety net: NFKD pass + drop any non-ASCII that nothing resolved.
  return out
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
}

export function toLatinUpper(input: string): string {
  if (!input) return "";
  return transliterate(input).toUpperCase();
}

export function digitsOnly(input: string): string {
  if (!input) return "";
  return input.replace(/\D+/g, "");
}
