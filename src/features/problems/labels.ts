// The name of a category of problems as the interface shows it: Sextant's own in the UI language, an extension's by
// the extension's name (ADR-0137).
import type { TFunction } from "i18next";
import { extensionCategoryTitle, isExtensionCategory } from "./extensionCategories";
import type { ProblemCategory } from "./model";

export function categoryLabel(t: TFunction, category: ProblemCategory): string {
  if (isExtensionCategory(category)) return extensionCategoryTitle(category) ?? category.slice("ext:".length);
  return t(`problems:categories.${category}`);
}
