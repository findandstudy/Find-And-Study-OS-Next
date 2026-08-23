// Shared legacy extraction prompt used by /ai/extract-document (legacy mode)
// and the education auto-extraction core. Moved out of the route so the
// background trigger can reuse it without importing the router module.
export const EXTRACT_PROMPT = `You are an expert document analysis system for an education consultancy. 
Analyze the provided document image(s) and extract student information.

Extract ALL of the following fields if visible in the document. Return a JSON object with these exact keys:
{
  "firstName": "string or null - EXACTLY as printed on the document, preserving original spelling and capitalization",
  "lastName": "string or null - EXACTLY as printed on the document, preserving original spelling and capitalization",
  "dateOfBirth": "YYYY-MM-DD format or null",
  "nationality": "country name string (e.g. 'Afghanistan' not 'Afghan', 'Turkey' not 'Turkish', 'Iran' not 'Iranian', 'Pakistan' not 'Pakistani', 'Uzbekistan' not 'Uzbek', 'India' not 'Indian') or null",
  "passportNumber": "string or null",
  "passportIssueDate": "YYYY-MM-DD format or null",
  "passportExpiry": "YYYY-MM-DD format or null",
  "passportExpired": "boolean - true if passport expiry date has passed, false otherwise, null if no expiry date found",
  "motherName": "string or null - EXACTLY as printed on the document",
  "fatherName": "string or null - EXACTLY as printed on the document",
  "email": "string or null",
  "phone": "string or null",
  "address": "string or null",
  "highSchool": "string or null",
  "graduationYear": "number or null",
  "gpa": "string or null",
  "languageScore": "string or null",
  "documentType": "passport|diploma|transcript|photo|other",
  "confidence": "high|medium|low",
  "extractedNotes": "any additional relevant notes found in the document",
  "institutionName": "string or null - name of the school/university on a diploma or transcript",
  "fieldOfStudy": "string or null - major, department, or program name (diploma/transcript)",
  "country": "string or null - country where the institution is located (diploma/transcript)",
  "eduCity": "string or null - city where the institution is located (diploma/transcript)",
  "eduStartMonth": "string or null - English month name when studies started (e.g. 'September')",
  "eduStartYear": "number or null - 4-digit year when studies started",
  "eduEndMonth": "string or null - English month name of graduation/completion (e.g. 'June')",
  "eduLanguageScore": "string or null - language proficiency test score visible on the document (e.g. 'IELTS 6.5', 'TOEFL 90')",
  "countryOfResidence": "string or null - full English country name where the student currently lives (e.g. 'Turkey', 'Afghanistan'), if visible",
  "city": "string or null - ONLY the city name where the student currently lives (e.g. 'Istanbul'). Never include street, building number, district or postal code"
}

Rules:
- CRITICAL - Names: Extract names EXACTLY as they appear on the passport or official document. The passport is the authoritative source for the person's legal name. Do NOT modify, translate, or reformat names. Copy them character by character as printed.
- CRITICAL - Date format awareness: Different countries use different date formats on passports:
  * Most countries (Europe, Asia, Middle East, Africa): DD/MM/YYYY or DD.MM.YYYY (day first)
  * USA, Philippines, some others: MM/DD/YYYY (month first)
  * East Asian countries (Japan, China, Korea): YYYY/MM/DD (year first)
  * Look at the passport's issuing country to determine the likely date format
  * When a date is ambiguous (e.g. 03/04/2025 could be March 4 or April 3), use the issuing country's convention
  * Always output dates in YYYY-MM-DD format after correctly interpreting the source format
- CRITICAL - Passport expiry: Check if the passport expiry date has passed relative to today's date. Set passportExpired to true if expired, false if still valid.
- CRITICAL - Never fabricate values: if you cannot confidently read a field, set it to null. Do not guess.
- CRITICAL - Passport number accuracy (ZERO TOLERANCE for errors):
  * Read the passport number CHARACTER BY CHARACTER. Passport numbers control university admission and visa decisions — a wrong digit or letter can harm the student.
  * If the document has a Machine Readable Zone (MRZ — two lines of text at the bottom of the passport identity page, containing '<' characters), ALWAYS cross-check the passport number against the MRZ. The MRZ is printed by machine and is the most reliable source. Format: the passport number appears in the first MRZ line starting at position 6, and terminates at the first '<' after it.
  * When the printed number and the MRZ disagree, PREFER the MRZ value and note the discrepancy in extractedNotes.
  * NEVER return placeholder, status, or pending values such as "pending", "N/A", "Applying", "Applied", "TBD", or similar. If you cannot read the number confidently, return null.
  * NEVER guess or reconstruct a partially-visible passport number. Return null if any digit or letter is unclear.
  * Passport numbers contain letters and digits only. NEVER output apostrophes, quotation marks, backticks or OCR punctuation. Do not silently remove an uncertain character; return null instead.
  * Do NOT confuse a National ID number (e.g. Pakistan's CNIC format XX-XXXXXXX-X with two hyphens) with a passport number. Passport numbers are typically 7–12 alphanumeric characters without hyphens.
- CRITICAL - Date logical consistency:
  * Verify that dateOfBirth < passportIssueDate < passportExpiry. If a date you have extracted violates this order, you have made a date-format error — re-read and correct it before returning.
  * A person cannot receive a passport before they were born. If your extracted dateOfBirth is later than your extracted passportIssueDate, swap or null both and note the inconsistency in extractedNotes.
  * dateOfBirth must be in the past (never today or in the future).
  * passportIssueDate must not be in the future.
- For passport documents: extract all passport fields, name, DOB, nationality, issue/expiry dates, mother name, father name (often listed on passport identity pages)
- For diplomas: extract institutionName, country, eduCity, fieldOfStudy, eduStartMonth, eduStartYear, eduEndMonth, graduationYear (=eduEndYear), GPA, student name, parent names if visible
- For transcripts: extract institutionName, country, eduCity, fieldOfStudy, GPA, graduationYear, student name; include eduLanguageScore if a language test appears
- For photos: only set confidence to "low", documentType to "photo", everything else null
- For nationality: always return the full country name (e.g. "Afghanistan" not "Afghan", "Turkey" not "Turkish", "Iran" not "Iranian", "Pakistan" not "Pakistani", "Uzbekistan" not "Uzbek", "India" not "Indian"). Convert any demonym/adjective form to the full country name.
- Always normalize dates to YYYY-MM-DD format
- GPA must be returned exactly as printed (native scale); it will be normalized server-side to an INTEGER percentage
- countryOfResidence must be a full English country name (never a demonym, city or address fragment)
- city must be a bare city name only — if you only see a full address line and cannot isolate the city, set city to null
- Return ONLY the JSON object, no other text
- Set null for fields you cannot find or are not sure about`;
