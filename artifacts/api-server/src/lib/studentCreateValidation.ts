export type StudentCreateValidationIssue = {
  field: string;
  message: string;
};

function optionalText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isValidStudentGpa(value: unknown): boolean {
  const text = optionalText(value);
  if (!text) return true;
  const ratio = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (ratio) {
    const score = Number(ratio[1]);
    const scale = Number(ratio[2]);
    return Number.isFinite(score) && Number.isFinite(scale) && scale > 0 && scale <= 100 && score >= 0 && score <= scale;
  }
  const score = Number(text);
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

export function validateStudentCreateFields(
  input: Record<string, unknown>,
  now = new Date(),
): StudentCreateValidationIssue[] {
  const issues: StudentCreateValidationIssue[] = [];
  const email = optionalText(input.email);
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    issues.push({ field: "email", message: "Enter a valid email address." });
  }

  const today = now.toISOString().slice(0, 10);
  const dateOfBirth = optionalText(input.dateOfBirth);
  const passportIssueDate = optionalText(input.passportIssueDate);
  const passportExpiry = optionalText(input.passportExpiry);

  if (dateOfBirth && !isRealIsoDate(dateOfBirth)) issues.push({ field: "dateOfBirth", message: "Enter a valid date of birth." });
  else if (dateOfBirth && dateOfBirth >= today) issues.push({ field: "dateOfBirth", message: "Date of birth must be in the past." });

  if (passportIssueDate && !isRealIsoDate(passportIssueDate)) issues.push({ field: "passportIssueDate", message: "Enter a valid passport issue date." });
  else if (passportIssueDate && passportIssueDate > today) issues.push({ field: "passportIssueDate", message: "Passport issue date cannot be in the future." });

  if (passportExpiry && !isRealIsoDate(passportExpiry)) issues.push({ field: "passportExpiry", message: "Enter a valid passport expiry date." });
  else if (passportExpiry && passportExpiry < today) issues.push({ field: "passportExpiry", message: "Passport has expired." });

  if (isRealIsoDate(passportIssueDate) && isRealIsoDate(passportExpiry) && passportExpiry <= passportIssueDate) {
    issues.push({ field: "passportExpiry", message: "Passport expiry date must be after its issue date." });
  }

  const graduationYearText = optionalText(input.graduationYear);
  if (graduationYearText) {
    const graduationYear = Number(graduationYearText);
    const maximum = now.getUTCFullYear() + 1;
    if (!Number.isInteger(graduationYear) || graduationYear < 1900 || graduationYear > maximum) {
      issues.push({ field: "graduationYear", message: `Graduation year must be between 1900 and ${maximum}.` });
    }
  }

  if (!isValidStudentGpa(input.gpa)) {
    issues.push({ field: "gpa", message: "GPA must be a number, or a score/scale pair where the score does not exceed the scale." });
  }
  return issues;
}
