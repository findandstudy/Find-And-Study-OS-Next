const FLAG_CDN = "https://flagcdn.com";

interface CountryFlagProps {
  code: string;
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  className?: string;
  rounded?: boolean;
  alt?: string;
}

const SIZES = {
  sm: { w: 16, h: 12, cls: "w-4 h-3" },
  md: { w: 20, h: 15, cls: "w-5 h-[15px]" },
  lg: { w: 24, h: 18, cls: "w-6 h-[18px]" },
  xl: { w: 32, h: 24, cls: "w-8 h-6" },
  "2xl": { w: 64, h: 48, cls: "w-16 h-12" },
  "3xl": { w: 108, h: 81, cls: "w-[108px] h-[81px]" },
};

export function CountryFlag({ code, size = "md", className = "", rounded = false, alt }: CountryFlagProps) {
  if (!code) return null;
  const lc = code.toLowerCase();
  const s = SIZES[size];
  return (
    <img
      src={`${FLAG_CDN}/${s.w}x${s.h}/${lc}.png`}
      srcSet={`${FLAG_CDN}/${s.w * 2}x${s.h * 2}/${lc}.png 2x`}
      alt={alt ?? code.toUpperCase()}
      className={`inline-block ${rounded ? "rounded-md" : "rounded-[2px]"} object-cover shadow-sm ${s.cls} ${className}`}
      loading="lazy"
    />
  );
}

const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  "afghanistan": "af", "albania": "al", "algeria": "dz", "andorra": "ad",
  "angola": "ao", "argentina": "ar", "armenia": "am", "australia": "au",
  "austria": "at", "azerbaijan": "az", "bahrain": "bh", "bangladesh": "bd",
  "belarus": "by", "belgium": "be", "bolivia": "bo", "bosnia and herzegovina": "ba",
  "brazil": "br", "bulgaria": "bg", "cambodia": "kh", "cameroon": "cm",
  "canada": "ca", "chile": "cl", "china": "cn", "colombia": "co",
  "croatia": "hr", "cuba": "cu", "cyprus": "cy", "czech republic": "cz",
  "czechia": "cz", "denmark": "dk", "ecuador": "ec", "egypt": "eg",
  "estonia": "ee", "ethiopia": "et", "finland": "fi", "france": "fr",
  "georgia": "ge", "germany": "de", "ghana": "gh", "greece": "gr",
  "hungary": "hu", "india": "in", "indonesia": "id", "iran": "ir",
  "iraq": "iq", "ireland": "ie", "israel": "il", "italy": "it",
  "japan": "jp", "jordan": "jo", "kazakhstan": "kz", "kenya": "ke",
  "kuwait": "kw", "kyrgyzstan": "kg", "latvia": "lv", "lebanon": "lb",
  "libya": "ly", "liechtenstein": "li", "lithuania": "lt", "luxembourg": "lu",
  "malaysia": "my", "maldives": "mv", "malta": "mt", "mexico": "mx",
  "moldova": "md", "monaco": "mc", "mongolia": "mn", "montenegro": "me",
  "morocco": "ma", "myanmar": "mm", "nepal": "np", "netherlands": "nl",
  "new zealand": "nz", "nigeria": "ng", "north korea": "kp", "north macedonia": "mk",
  "norway": "no", "oman": "om", "pakistan": "pk", "palestine": "ps",
  "panama": "pa", "paraguay": "py", "peru": "pe", "philippines": "ph",
  "poland": "pl", "portugal": "pt", "qatar": "qa", "romania": "ro",
  "russia": "ru", "russian federation": "ru", "saudi arabia": "sa",
  "serbia": "rs", "singapore": "sg", "slovakia": "sk", "slovenia": "si",
  "somalia": "so", "south africa": "za", "south korea": "kr", "spain": "es",
  "sri lanka": "lk", "sudan": "sd", "sweden": "se", "switzerland": "ch",
  "syria": "sy", "taiwan": "tw", "tajikistan": "tj", "tanzania": "tz",
  "thailand": "th", "tunisia": "tn", "turkey": "tr", "türkiye": "tr",
  "turkmenistan": "tm", "ukraine": "ua", "united arab emirates": "ae",
  "uae": "ae", "united kingdom": "gb", "uk": "gb", "united states": "us",
  "usa": "us", "united states of america": "us", "uruguay": "uy",
  "uzbekistan": "uz", "venezuela": "ve", "vietnam": "vn", "yemen": "ye",
  "zimbabwe": "zw",
};

export function countryNameToIso(name: string): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO[key] ?? null;
}

export function countryCodeFromEmoji(emoji: string): string | null {
  const codePoints = [...emoji]
    .map(c => c.codePointAt(0))
    .filter((cp): cp is number => cp !== undefined && cp >= 0x1F1E6 && cp <= 0x1F1FF);
  if (codePoints.length !== 2) return null;
  return String.fromCharCode(codePoints[0] - 0x1F1E6 + 65, codePoints[1] - 0x1F1E6 + 65);
}
