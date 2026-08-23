import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS, isSupportedCurrency, type CurrencyCode } from "@/lib/currency";
import { useI18n } from "@/hooks/use-i18n";
import { useCurrenciesInUse } from "@/hooks/use-currencies-in-use";
import type { CurrencyFilter } from "@/hooks/use-currency-preference";

interface Props {
  value: CurrencyFilter;
  onChange: (v: CurrencyFilter) => void;
  includeAll?: boolean;
  className?: string;
  triggerClassName?: string;
  currencies?: CurrencyCode[];
}

export function CurrencySelector({ value, onChange, includeAll = true, className, triggerClassName, currencies }: Props) {
  const { t } = useI18n();
  const fetched = useCurrenciesInUse();
  const hasExplicit = !!(currencies && currencies.length > 0);
  const list: CurrencyCode[] = hasExplicit ? currencies! : fetched.list;
  const isReady = hasExplicit || fetched.isReady;

  // Only reset selection AFTER the authoritative list has loaded — never during
  // the initial fetch — so a persisted preference (e.g. EUR) isn't clobbered.
  useEffect(() => {
    if (!isReady) return;
    if (value === "all") return;
    if (isSupportedCurrency(value) && !list.includes(value)) {
      onChange(includeAll ? "all" : list[0]);
    }
  }, [isReady, list, value, includeAll, onChange]);

  return (
    <div className={className}>
      <Select value={value} onValueChange={(v) => onChange(v as CurrencyFilter)}>
        <SelectTrigger className={triggerClassName || "h-9 w-[180px]"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {list.map((c) => (
            <SelectItem key={c} value={c}>
              <span className="inline-flex items-center gap-2">
                <span className="text-muted-foreground w-4 inline-block text-center">{CURRENCY_SYMBOLS[c]}</span>
                <span>{c}</span>
              </span>
            </SelectItem>
          ))}
          {includeAll && (
            <SelectItem value="all">{t("currencyAllLabel")}</SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
