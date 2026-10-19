// Snippets in a terminal tab (#154): the "Snippets" menu that types a snippet into the focused pane (Insert) or types
// it and presses Enter (Run), and the manager that adds, edits and deletes them (saved in the settings).
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings, useSettings } from "../../api";
import { Button, Dialog, usePopup, usePopupPosition } from "../../components";
import { formatList } from "../../i18n/format";
import {
  deleteSnippet,
  fillSnippet,
  hasHiddenChars,
  isValidSnippet,
  MAX_SNIPPET_COMMAND_CHARS,
  MAX_SNIPPET_NAME_CHARS,
  newSnippetId,
  PLACEHOLDERS,
  snippetInput,
  upsertSnippet,
  type PaneContext,
  type ShellKind,
  type Snippet,
} from "./snippets";
import { useBroadcast } from "./broadcast";

/** Above this many snippets the menu offers a filter field. */
const FILTER_FROM = 8;

export interface SnippetsMenuProps {
  /** Placeholder values of the focused pane. */
  context: PaneContext;
  /** How the focused pane's shell quotes values. */
  shell: ShellKind;
  /** Types into the focused pane. */
  send: (data: string) => void;
  /** Gives the keyboard back to the pane. */
  afterInsert: () => void;
}

export function SnippetsMenu({ context, shell, send, afterInsert }: SnippetsMenuProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  usePopup(ref, () => setOpen(false), open);
  // Under the button's right edge; the terminal sits at the bottom of the window, so it usually opens upwards.
  usePopupPosition(menuRef, ref, { open, align: "end", gap: 4 });
  const broadcasting = useBroadcast((s) => s.targets !== null);
  const snippets = settings?.snippets ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? snippets.filter((s) => s.name.toLowerCase().includes(needle) || s.command.toLowerCase().includes(needle))
    : snippets;
  const use = (snippet: Snippet, run: boolean) => {
    const input = snippetInput(fillSnippet(snippet.command, context, shell), run);
    if (input === null) return;
    send(input);
    setOpen(false);
    afterInsert();
  };
  return (
    <div className="terminal-snippets" ref={ref}>
      <Button size="compact" icon="chevronDown" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>
        {t("terminal:snippets.button")}
      </Button>
      {open && (
        <div id={menuId} ref={menuRef} className="terminal-snippets__menu" role="region" aria-label={t("terminal:snippets.button")}>
          {snippets.length > FILTER_FROM && (
            <input
              type="search"
              className="terminal-snippets__filter"
              aria-label={t("terminal:snippets.filter")}
              placeholder={t("terminal:snippets.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {snippets.length === 0 && <p className="terminal-form__hint">{t("terminal:snippets.empty")}</p>}
          {broadcasting && snippets.length > 0 && (
            <p className="terminal-form__hint" role="note">
              {t("terminal:snippets.focusedOnly")}
            </p>
          )}
          <ul className="terminal-snippets__list">
            {shown.map((snippet) => {
              const filled = fillSnippet(snippet.command, context, shell);
              const usable = filled.missing.length === 0 && filled.refused.length === 0 && filled.text !== "";
              return (
                <li key={snippet.id} className="terminal-snippets__item">
                  <div className="terminal-snippets__text">
                    <span className="terminal-snippets__name">{snippet.name}</span>
                    <code className="terminal-form__mono" title={filled.text}>
                      {filled.text}
                    </code>
                    {filled.missing.length > 0 && (
                      <small className="terminal-form__hint">
                        {t("terminal:snippets.missing", { placeholders: formatList(filled.missing.map((p) => `{{${p}}}`)) })}
                      </small>
                    )}
                    {filled.refused.length > 0 && (
                      <small className="terminal-form__hint">
                        {t("terminal:snippets.unquotable", { placeholders: formatList(filled.refused.map((p) => `{{${p}}}`)) })}
                      </small>
                    )}
                  </div>
                  <Button
                    size="compact"
                    disabled={!usable}
                    title={t(broadcasting ? "terminal:snippets.insertTitleFocused" : "terminal:snippets.insertTitle")}
                    aria-label={t("terminal:snippets.insertNamed", { name: snippet.name })}
                    onClick={() => use(snippet, false)}
                  >
                    {t("terminal:snippets.insert")}
                  </Button>
                  <Button
                    size="compact"
                    variant="primary"
                    disabled={!usable}
                    title={t(broadcasting ? "terminal:snippets.runTitleFocused" : "terminal:snippets.runTitle")}
                    aria-label={t("terminal:snippets.runNamed", { name: snippet.name })}
                    onClick={() => use(snippet, true)}
                  >
                    {t("terminal:snippets.run")}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Button
            size="compact"
            icon="settings"
            onClick={() => {
              setOpen(false);
              setManaging(true);
            }}
          >
            {t("terminal:snippets.manage")}
          </Button>
        </div>
      )}
      {managing && <SnippetManager close={() => setManaging(false)} />}
    </div>
  );
}

/** Adds, edits and deletes snippets; each change is saved to the settings at once. */
export function SnippetManager({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const snippets = settings?.snippets ?? [];
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [error, setError] = useState(false);
  const save = (change: (list: Snippet[]) => Snippet[]) =>
    updateSettings((s) => ({ ...s, snippets: change(s.snippets) })).then(
      () => setError(false),
      () => setError(true),
    );
  return (
    <Dialog open title={t("terminal:snippets.managerTitle")} onClose={close}>
      <div className="terminal-form">
        {editing ? (
          <SnippetForm
            snippet={editing}
            onCancel={() => setEditing(null)}
            onSave={(snippet) => {
              setEditing(null);
              void save((list) => upsertSnippet(list, snippet));
            }}
          />
        ) : (
          <>
            {snippets.length === 0 && <p className="terminal-form__hint">{t("terminal:snippets.empty")}</p>}
            <ul className="terminal-snippets__list">
              {snippets.map((snippet) => (
                <li key={snippet.id} className="terminal-snippets__item">
                  <div className="terminal-snippets__text">
                    <span className="terminal-snippets__name">{snippet.name}</span>
                    <code className="terminal-form__mono">{snippet.command}</code>
                  </div>
                  <Button
                    size="compact"
                    iconOnly
                    icon="edit"
                    label={t("terminal:snippets.editNamed", { name: snippet.name })}
                    onClick={() => setEditing(snippet)}
                  />
                  <Button
                    size="compact"
                    iconOnly
                    icon="delete"
                    label={t("terminal:snippets.deleteNamed", { name: snippet.name })}
                    onClick={() => void save((list) => deleteSnippet(list, snippet.id))}
                  />
                </li>
              ))}
            </ul>
            <div className="terminal-form__row">
              <Button icon="add" onClick={() => setEditing({ id: newSnippetId(), name: "", command: "" })}>
                {t("terminal:snippets.add")}
              </Button>
            </div>
          </>
        )}
        {error && (
          <p className="terminal-form__status terminal-form__status--error" role="alert">
            {t("terminal:snippets.saveFailed")}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function SnippetForm({
  snippet,
  onSave,
  onCancel,
}: {
  snippet: Snippet;
  onSave: (snippet: Snippet) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(snippet.name);
  const [command, setCommand] = useState(snippet.command);
  const nameId = useId();
  const commandId = useId();
  const valid = isValidSnippet({ name, command });
  const placeholders = formatList(PLACEHOLDERS.map((p) => `{{${p}}}`));
  return (
    <form
      className="terminal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ id: snippet.id, name: name.trim(), command: command.trim() });
      }}
    >
      <div className="terminal-form__field">
        <label htmlFor={nameId}>{t("terminal:snippets.name")}</label>
        <input
          id={nameId}
          type="text"
          maxLength={MAX_SNIPPET_NAME_CHARS}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="terminal-form__field">
        <label htmlFor={commandId}>{t("terminal:snippets.command")}</label>
        <input
          id={commandId}
          type="text"
          maxLength={MAX_SNIPPET_COMMAND_CHARS}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <span className="terminal-form__hint">{t("terminal:snippets.placeholdersHint", { placeholders })}</span>
      </div>
      {(hasHiddenChars(name) || hasHiddenChars(command)) && (
        <p className="terminal-form__hint" role="alert">
          {t("terminal:snippets.hiddenChars")}
        </p>
      )}
      {!valid && (name !== "" || command !== "") && (
        <p className="terminal-form__hint">
          {t("terminal:snippets.invalid", { nameMax: MAX_SNIPPET_NAME_CHARS, commandMax: MAX_SNIPPET_COMMAND_CHARS })}
        </p>
      )}
      <div className="terminal-form__row">
        <Button onClick={onCancel}>{t("common:actions.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          {t("terminal:snippets.save")}
        </Button>
      </div>
    </form>
  );
}
