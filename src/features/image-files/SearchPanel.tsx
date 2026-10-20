// Search by path in the open image (`image_files_search`, at most 500 matches), asked 300 ms after the last keystroke.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ImageEntry, type ImageSearch } from "../../api";
import { Button, ErrorState, Icon } from "../../components";
import { entryIcon } from "./FileTree";

const DELAY_MS = 300;

export function SearchPanel({ sessionId, onSelect }: { sessionId: string; onSelect(entry: ImageEntry): void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; search: ImageSearch } | { query: string; error: unknown } | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.imageFiles.search(sessionId, text).then(
        (search) => live && setResult({ query: text, search }),
        (error: unknown) => live && setResult({ query: text, error }),
      );
    }, DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, query]);

  return (
    <div className="imgf-search">
      <div className="imgf-search__row">
        <input
          className="imgf-input"
          type="search"
          value={query}
          maxLength={256}
          aria-label={t("imagefiles:search.label")}
          placeholder={t("imagefiles:search.placeholder")}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <Button size="compact" iconOnly icon="close" label={t("imagefiles:search.clear")} onClick={() => setQuery("")} />}
      </div>
      {result && "error" in result && <ErrorState className="imgf-error" error={result.error} />}
      {result && "search" in result && (
        <>
          {result.search.matches.length === 0 ? (
            <p className="imgf-note">{t("imagefiles:search.none")}</p>
          ) : (
            <ul className="imgf-search__list" aria-label={t("imagefiles:search.label")}>
              {result.search.matches.map((entry) => (
                <li key={entry.path}>
                  <button type="button" className="imgf-tree__name" onClick={() => onSelect(entry)}>
                    <Icon name={entryIcon(entry)} />
                    <span className="imgf-tree__text">{entry.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result.search.truncated && (
            <p className="imgf-note">{t("imagefiles:search.truncated", { count: result.search.matches.length })}</p>
          )}
        </>
      )}
    </div>
  );
}
