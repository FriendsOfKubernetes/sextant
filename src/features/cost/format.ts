// Money and shares in the UI language. With a currency the API named, amounts are formatted as that currency;
// without one they are plain numbers (the views say in which unit they are).
import { currentLanguage } from "../../i18n/format";

/** An amount with two fraction digits, in `currency` when given. */
export function formatMoney(value: number, currency: string | null): string {
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (currency) {
    try {
      return new Intl.NumberFormat(currentLanguage(), { ...options, style: "currency", currency }).format(value);
    } catch {
      // An unknown code: the plain number.
    }
  }
  return new Intl.NumberFormat(currentLanguage(), options).format(value);
}

/** A fraction as a percentage without decimals ("25 %" in German). */
export function formatShare(fraction: number): string {
  return new Intl.NumberFormat(currentLanguage(), { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}
