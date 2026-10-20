// The image's folders as a lazy tree: a folder's entries are asked for when it is first expanded (`image_files_list`).
// Plain nested lists of buttons: the expander says expanded/collapsed, the name selects the entry.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ImageDir, type ImageEntry } from "../../api";
import { Button, ErrorState, Icon, LoadingIndicator, type IconName } from "../../components";

type Folder = { status: "loading" } | { status: "ready"; dir: ImageDir } | { status: "error"; error: unknown };

export function entryIcon(entry: ImageEntry): IconName {
  if (entry.kind === "directory") return "imageFolder";
  if (entry.kind === "symlink") return "imageSymlink";
  return "imageFile";
}

export interface FileTreeProps {
  sessionId: string;
  selected: string | null;
  /** Folders to show expanded (a search result's parents); added to what the user expanded. */
  reveal: readonly string[];
  onSelect(entry: ImageEntry): void;
}

export function FileTree({ sessionId, selected, reveal, onSelect }: FileTreeProps) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["/"]));

  const load = useCallback(
    (path: string) => {
      setFolders((f) => (f[path] && f[path].status !== "error" ? f : { ...f, [path]: { status: "loading" } }));
      api.imageFiles.list(sessionId, path).then(
        (dir) => setFolders((f) => ({ ...f, [path]: { status: "ready", dir } })),
        (error: unknown) => setFolders((f) => ({ ...f, [path]: { status: "error", error } })),
      );
    },
    [sessionId],
  );

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of reveal) next.add(path);
      return next;
    });
  }, [reveal]);

  useEffect(() => {
    for (const path of expanded) if (!folders[path]) load(path);
  }, [expanded, folders, load]);

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderFolder = (path: string) => {
    const folder = folders[path];
    if (!folder || folder.status === "loading") return <LoadingIndicator className="imgf-tree__loading" text={t("imagefiles:tree.loading")} />;
    if (folder.status === "error") return <ErrorState className="imgf-error" error={folder.error} onRetry={() => load(path)} />;
    if (folder.dir.entries.length === 0) return <p className="imgf-note">{t("imagefiles:tree.empty")}</p>;
    return (
      <>
        <ul className="imgf-tree__list">
          {folder.dir.entries.map((entry) => {
            const open = expanded.has(entry.path);
            const folderEntry = entry.kind === "directory";
            return (
              <li key={entry.path} className="imgf-tree__item">
                <div className="imgf-tree__row">
                  {folderEntry && entry.hasChildren ? (
                    <Button
                      size="compact"
                      iconOnly
                      icon={open ? "chevronDown" : "chevronRight"}
                      aria-expanded={open}
                      label={t(open ? "imagefiles:tree.collapse" : "imagefiles:tree.expand", { name: entry.name })}
                      onClick={() => toggle(entry.path)}
                    />
                  ) : (
                    <span className="imgf-tree__spacer" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    className={entry.path === selected ? "imgf-tree__name imgf-tree__name--selected" : "imgf-tree__name"}
                    aria-current={entry.path === selected ? "true" : undefined}
                    onClick={() => onSelect(entry)}
                  >
                    <Icon name={entryIcon(entry)} />
                    <span className="imgf-tree__text">{entry.name}</span>
                  </button>
                </div>
                {folderEntry && open && renderFolder(entry.path)}
              </li>
            );
          })}
        </ul>
        {folder.dir.truncated && <p className="imgf-note">{t("imagefiles:tree.truncated", { count: folder.dir.entries.length })}</p>}
      </>
    );
  };

  return (
    <nav className="imgf-tree" aria-label={t("imagefiles:tree.label")}>
      {renderFolder("/")}
    </nav>
  );
}
