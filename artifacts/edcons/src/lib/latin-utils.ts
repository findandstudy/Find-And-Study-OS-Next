const TR_TO_LATIN_MAP: Record<string, string> = {
  "ç": "c", "Ç": "C",
  "ğ": "g", "Ğ": "G",
  "ı": "i", "İ": "I",
  "ö": "o", "Ö": "O",
  "ş": "s", "Ş": "S",
  "ü": "u", "Ü": "U",
  "â": "a", "Â": "A",
  "î": "i", "Î": "I",
  "û": "u", "Û": "U",
  "ə": "e", "Ə": "E",
  "ø": "o", "Ø": "O",
  "ß": "ss",
  "æ": "ae", "Æ": "AE",
  "œ": "oe", "Œ": "OE",
  "ð": "d", "Ð": "D",
  "þ": "th", "Þ": "Th",
  "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L",
};

export function transliterateToLatin(input: string): string {
  let out = "";
  for (const ch of input) {
    if (TR_TO_LATIN_MAP[ch] !== undefined) {
      out += TR_TO_LATIN_MAP[ch];
      continue;
    }
    const stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += stripped;
  }
  return out
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
}

export function toLatinUpper(input: string): string {
  if (!input) return "";
  return transliterateToLatin(input).toUpperCase();
}
