// Names of the UI languages found in src/locales/ (a directory per language code).

/** The language's own name ("English" for "en"); the code itself when the platform does not know it. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // Not a valid language tag: show the directory name.
  }
  return code;
}
