// An extension's counter label by CLDR plural form (#398): the form the UI language's rules pick for the count, else
// `other` (the manifest always gives it), with `{{count}}` as the number written in the UI language.
import { currentLanguage, formatNumber } from "../i18n/format";

export function pluralLabel(forms: Record<string, string>, count: number, language: string = currentLanguage()): string {
  let form = "other";
  try {
    form = new Intl.PluralRules(language).select(count);
  } catch {
    // An odd language tag: `other`.
  }
  const text = forms[form] ?? forms.other ?? "{{count}}";
  return text.split("{{count}}").join(formatNumber(count));
}
