import * as React from "react";
import PhoneInput, { isValidPhoneNumber, parsePhoneNumber } from "react-phone-number-input";
import type { Country } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/hooks/use-i18n";

export { isValidPhoneNumber };

const InnerInput = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof Input>>(
  (props, ref) => <Input {...props} ref={ref} className={cn("flex-1 min-w-0", props.className)} />,
);
InnerInput.displayName = "PhoneFieldInnerInput";

export interface PhoneFieldProps {
  /** E.164 value (e.g. "+905055585181") or "" when empty. */
  value: string;
  onChange: (value: string) => void;
  defaultCountry?: Country;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  /** Show the inline invalid-number hint (default true). */
  showError?: boolean;
  id?: string;
}

/**
 * Country-aware phone input (react-phone-number-input / libphonenumber).
 * Emits E.164 strings; shows an inline i18n error while the typed number is
 * invalid for the selected country. Backend still enforces via 422
 * `phone.invalid`.
 */
export function PhoneField({
  value,
  onChange,
  defaultCountry = "TR",
  disabled,
  required,
  placeholder,
  className,
  showError = true,
  id,
}: PhoneFieldProps) {
  const { t } = useI18n();
  const invalid = !!value && !isValidPhoneNumber(value);
  const empty = !value;
  return (
    <div className={cn("space-y-1", className)}>
      <PhoneInput
        id={id}
        international
        defaultCountry={defaultCountry}
        countryOptionsOrder={["TR", "UZ", "KZ", "AZ", "TM", "KG", "RU", "|", "..."]}
        value={value || undefined}
        onChange={(v) => onChange(v ?? "")}
        disabled={disabled}
        placeholder={placeholder || "+90 505 558 51 81"}
        inputComponent={InnerInput}
        className="flex items-center gap-2 [&_.PhoneInputCountry]:shrink-0 [&_.PhoneInputCountrySelect]:cursor-pointer"
      />
      {showError && invalid && (
        <p className="text-xs text-destructive">{t("phone.invalid")}</p>
      )}
      {showError && required && empty && (
        <p className="text-xs text-muted-foreground">{t("phone.required")}</p>
      )}
    </div>
  );
}

/**
 * Best-effort conversion of a stored phone (E.164 or legacy free-form) into
 * a value the PhoneField can edit. Legacy national numbers parse with TR
 * default; unparseable non-"+" strings return "" (user re-enters).
 */
export function toPhoneFieldValue(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  try {
    const parsed = parsePhoneNumber(trimmed, "TR");
    if (parsed) return parsed.number;
  } catch {
    /* fall through */
  }
  return trimmed.startsWith("+") ? trimmed : "";
}

/** True when the field passes submit-gating: valid, or empty when optional. */
export function isPhoneFieldValid(value: string, required?: boolean): boolean {
  if (!value) return !required;
  return isValidPhoneNumber(value);
}
