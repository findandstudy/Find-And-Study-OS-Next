export type StudentIntakeValidationInput = {
  email: string;
  dateOfBirth: string;
  passportIssueDate: string;
  passportExpiry: string;
  graduationYear: string;
  gpa: string;
  gradingSystem: string;
};

export function resolveCountryInput(searchValue: string, currentValue: string): string {
  return searchValue.trim() || currentValue;
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function validateStudentIntakeForm(
  input: StudentIntakeValidationInput,
  now = new Date(),
): string[] {
  const errors: string[] = [];
  const email = input.email.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Enter a valid email address.");
  }

  const today = now.toISOString().slice(0, 10);
  if (!isRealIsoDate(input.dateOfBirth)) errors.push("Enter a valid date of birth.");
  else if (input.dateOfBirth >= today) errors.push("Date of birth must be in the past.");

  if (!isRealIsoDate(input.passportIssueDate)) errors.push("Enter a valid passport issue date.");
  else if (input.passportIssueDate > today) errors.push("Passport issue date cannot be in the future.");

  if (!isRealIsoDate(input.passportExpiry)) errors.push("Enter a valid passport expiry date.");
  else if (input.passportExpiry < today) errors.push("Passport has expired. Enter a currently valid passport.");

  if (isRealIsoDate(input.passportIssueDate) && isRealIsoDate(input.passportExpiry) && input.passportExpiry <= input.passportIssueDate) {
    errors.push("Passport expiry date must be after its issue date.");
  }

  const graduationYear = input.graduationYear.trim();
  if (graduationYear) {
    const parsed = Number(graduationYear);
    const maximum = now.getUTCFullYear() + 1;
    if (!Number.isInteger(parsed) || parsed < 1900 || parsed > maximum) {
      errors.push(`Graduation year must be between 1900 and ${maximum}.`);
    }
  }

  const gpa = input.gpa.trim();
  if (gpa) {
    const parsedGpa = Number(gpa);
    const parsedScale = Number(input.gradingSystem);
    if (!Number.isFinite(parsedScale) || parsedScale <= 0) errors.push("Select a valid GPA scale.");
    else if (!Number.isFinite(parsedGpa) || parsedGpa < 0 || parsedGpa > parsedScale) errors.push(`GPA must be between 0 and ${parsedScale}.`);
  }
  return errors;
}
