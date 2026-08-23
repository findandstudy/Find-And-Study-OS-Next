export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: string;
}

export function calcPasswordStrength(password: string): StrengthResult {
  if (!password) return { score: 0, label: "", color: "" };
  const hasMin = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasLong = password.length >= 12;
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  const score = [hasMin, hasUpper, hasDigit, hasLong || hasSpecial].filter(Boolean).length as 0 | 1 | 2 | 3 | 4;

  return { score, label: "", color: "" };
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 8) return "min8";
  if (!/[A-Z]/.test(password)) return "needsUpper";
  if (!/[0-9]/.test(password)) return "needsDigit";
  return null;
}
