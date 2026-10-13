// A filterable checklist with a field to add an item by name: namespaces and kinds of a rule are chosen with it.
// Chosen items are always listed (first), whether the cluster knows them or not, so any of them can be unchecked.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox } from "../../components";

export interface PickerItem {
  key: string;
  label: string;
  /** Muted text after the label (the API group). */
  hint?: string;
}

export interface PickerProps {
  /** Already translated labels. */
  filterLabel: string;
  addLabel: string;
  addPlaceholder: string;
  addButtonLabel: string;
  invalidText: string;
  /** Everything the cluster offers, without the chosen items that it does not know. */
  items: readonly PickerItem[];
  /** The chosen items (all of them, known or not). */
  chosen: readonly PickerItem[];
  /** Why the list from the cluster is missing, if it is. */
  unavailable: "notConnected" | "loading" | "failed" | null;
  onToggle: (key: string, on: boolean) => void;
  /** `true` when `text` was added; `false` when it is not a valid name (the field shows `invalidText`). */
  onAdd: (text: string) => boolean;
  /** At most this many unchosen items are drawn. */
  limit?: number;
  moreText?: (shown: number) => ReactNode;
}

export function Picker({
  filterLabel,
  addLabel,
  addPlaceholder,
  addButtonLabel,
  invalidText,
  items,
  chosen,
  unavailable,
  onToggle,
  onAdd,
  limit = 200,
  moreText,
}: PickerProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);

  const chosenKeys = new Set(chosen.map((c) => c.key));
  const needle = filter.trim().toLowerCase();
  const matches = items.filter(
    (i) => !chosenKeys.has(i.key) && (!needle || `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(needle)),
  );
  const shown = matches.slice(0, limit);
  const rows = [...chosen, ...shown];

  const add = () => {
    if (!text.trim()) return;
    const ok = onAdd(text);
    setInvalid(!ok);
    if (ok) setText("");
  };

  return (
    <div className="aa-picker">
      {unavailable && <div className="aa-note">{t(`access:picker.${unavailable}`)}</div>}
      {items.length > 0 && (
        <input
          type="text"
          className="aa-input"
          aria-label={filterLabel}
          placeholder={filterLabel}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {rows.length > 0 ? (
        <div className="aa-picker__list">
          {rows.map((item) => (
            <label key={item.key} className="aa-picker__row">
              <Checkbox checked={chosenKeys.has(item.key)} onChange={(e) => onToggle(item.key, e.target.checked)} />
              <span>{item.label}</span>
              {item.hint && <span className="aa-picker__hint">{item.hint}</span>}
            </label>
          ))}
        </div>
      ) : (
        items.length > 0 && <div className="aa-note">{t("access:picker.noMatch")}</div>
      )}
      {rows.length > 0 && needle && matches.length === 0 && <div className="aa-note">{t("access:picker.noMatch")}</div>}
      {matches.length > shown.length && moreText && <div className="aa-note">{moreText(shown.length)}</div>}
      <div className="aa-picker__add">
        <input
          type="text"
          className="aa-input"
          aria-label={addLabel}
          placeholder={addPlaceholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button onClick={add} disabled={!text.trim()}>
          {addButtonLabel}
        </Button>
      </div>
      {invalid && (
        <div className="aa-invalid" role="alert">
          {invalidText}
        </div>
      )}
    </div>
  );
}
