// "Save view" in the header of a kind table: names the table as it is now (kind, namespaces, search, Only problems,
// label selector, sort, visible columns) and saves it for this cluster or every cluster, optionally pinned.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { tableStateOf, useAppStore, useClusterView } from "../../app/store";
import { Button, Checkbox, Dialog, Icon, Radio } from "../../components";
import type { TableToolProps } from "../../layout/main/tableTools";
import { captureView, MAX_VIEWS, newId, togglePin, withView } from "./model";
import { save } from "./ui";

export function SaveViewTool({ clusterId, view }: TableToolProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t("views:save.button");
  return (
    <>
      <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => setOpen(true)}>
        <Icon name="saveView" />
      </button>
      {open && <SaveViewDialog clusterId={clusterId} view={view} onClose={() => setOpen(false)} />}
    </>
  );
}

function SaveViewDialog({ clusterId, view, onClose }: TableToolProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const clusterView = useClusterView(clusterId);
  const setTableState = useAppStore((s) => s.setTableState);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"cluster" | "all">("cluster");
  const [selector, setSelector] = useState(() => tableStateOf(clusterView, view).labelSelector);
  const [pin, setPin] = useState(false);
  const full = (settings?.views.length ?? 0) >= MAX_VIEWS;
  const canSave = name.trim().length > 0 && !full;

  const submit = () => {
    if (!canSave) return;
    // The selector typed here becomes the table's, so the view saves what the table shows.
    setTableState(clusterId, view, { labelSelector: selector.trim() });
    const saved = captureView(clusterId, name, scope);
    if (!saved) return;
    save((current) => {
      const next = withView(current, saved);
      if (!pin) return next;
      return togglePin(next, { id: newId("p"), cluster: clusterId, target: { type: "view", view: saved.id } });
    });
    onClose();
  };

  return (
    <Dialog
      open
      title={t("views:save.title")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("views:save.cancel")}</Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            {t("views:save.save")}
          </Button>
        </>
      }
    >
      <form
        className="views-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="views-form__hint">{t("views:save.captures")}</p>
        {full && <p role="alert">{t("views:save.full")}</p>}
        <label className="views-form__field">
          <span>{t("views:save.name")}</span>
          <input
            autoFocus
            value={name}
            maxLength={120}
            placeholder={t("views:save.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="views-form__field">
          <legend>{t("views:save.scope")}</legend>
          <label className="views-form__choice">
            <Radio name="views-scope" checked={scope === "cluster"} onChange={() => setScope("cluster")} />
            {t("views:save.scopeCluster")}
          </label>
          <label className="views-form__choice">
            <Radio name="views-scope" checked={scope === "all"} onChange={() => setScope("all")} />
            {t("views:save.scopeAll")}
          </label>
        </fieldset>
        <label className="views-form__field">
          <span>{t("views:save.labelSelector")}</span>
          <input value={selector} maxLength={1000} onChange={(e) => setSelector(e.target.value)} />
          <small>{t("views:save.labelSelectorHint")}</small>
        </label>
        <label className="views-form__choice">
          <Checkbox checked={pin} onChange={(e) => setPin(e.target.checked)} />
          {t("views:save.pin")}
        </label>
      </form>
    </Dialog>
  );
}
