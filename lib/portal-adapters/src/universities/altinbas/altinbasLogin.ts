export type AltinbasLoginFailureKind =
  | "invalid_credentials"
  | "captcha_or_rate_limit"
  | "unknown";

export interface AltinbasLoginFailureEvidence {
  bodyText?: string | null;
  captchaDetected?: boolean;
  passwordVisible: boolean;
  loginUrlVisible?: boolean;
}

/**
 * Classify the Altınbaş login screen without returning or logging portal text.
 * The caller uses only this bounded enum so usernames, passwords and page
 * content never reach worker logs.
 */
export function classifyAltinbasLoginFailure(
  evidence: AltinbasLoginFailureEvidence,
): AltinbasLoginFailureKind | null {
  const body = String(evidence.bodyText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (
    evidence.captchaDetected ||
    /\b(?:captcha|recaptcha|hcaptcha)\b|verify (?:that )?you(?:'re| are) (?:a )?human|unusual traffic|too many (?:login )?attempts|try again later/.test(
      body,
    )
  ) {
    return "captcha_or_rate_limit";
  }

  if (
    /couldn['’]?t find an account associated with that username\/password|incorrect (?:username|password)|invalid (?:username|password|credentials)|wrong (?:username|password|credentials)|account associated with that username\/password/.test(
      body,
    )
  ) {
    return "invalid_credentials";
  }

  if (evidence.passwordVisible || evidence.loginUrlVisible) return "unknown";
  return null;
}

