// "Set image of <name>": every container and init container with its current image and a field for the new one,
// checked as it is typed; what would change; then, through safe apply (#141), the API server's dry run of the patch
// next to the live object — always first on a cluster that asks for previews, one button away otherwise. "Set image"
// sends the one patch the core builds (`workload_set_image`), never repeated; a failure keeps the dialog open. A change
// confirmed from a preview carries the version the preview read: when the object changed since (`conflict`), the
// dialog previews again and says so, so the user confirms what is live now.
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  toApiError,
  type ApiError,
  type ClusterId,
  type DryRunResult,
  type KubeObject,
  type ObjectRef,
  type SetImageChange,
} from "../../api";
import { Badge, Button, Dialog, ErrorState } from "../../components";
import { ChangePreview, useAlwaysPreview } from "../safe-apply";
import { changesOf, containerKey, containersOf, type ContainerImage, type SetImageKind } from "./model";
import { checkImage } from "./reference";

interface Preview {
  changes: SetImageChange[];
  result: DryRunResult;
  /** The live object's version the dry run read; the change is refused when it is no longer the live one. */
  resourceVersion: string;
  /** This preview replaced one the object had changed since. */
  renewed: boolean;
}

export interface SetImageDialogProps {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  obj: KubeObject;
  kind: SetImageKind;
  close: () => void;
}

type Phase = "edit" | "checking" | "saving";

export function SetImageDialog({ clusterId, objectRef, obj, kind, close }: SetImageDialogProps) {
  const { t } = useTranslation();
  const containers = useMemo(() => containersOf(obj, kind), [obj, kind]);
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(containers.map((c) => [containerKey(c), c.image])),
  );
  const [phase, setPhase] = useState<Phase>("edit");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const alwaysPreview = useAlwaysPreview(clusterId);
  const changes = useMemo(() => changesOf(containers, typed), [containers, typed]);
  const valid = changes.length > 0 && changes.every((c) => checkImage(c.image).ok);
  const busy = phase !== "edit";

  const dryRun = async (asked: SetImageChange[], renewed: boolean) => {
    const { result, resourceVersion } = await api.actions.setImageDryRun(clusterId, objectRef, asked);
    setPreview({ changes: asked, result, resourceVersion, renewed });
  };

  const runPreview = async () => {
    const asked = changes;
    setPhase("checking");
    setError(null);
    try {
      await dryRun(asked, false);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setPhase("edit");
    }
  };

  const apply = async (asked: SetImageChange[], previewed?: string) => {
    setPhase("saving");
    setError(null);
    try {
      await api.actions.setImage(clusterId, objectRef, asked, previewed);
      close();
      return;
    } catch (err) {
      const refused = toApiError(err);
      if (previewed === undefined || refused.code !== "conflict") {
        setError(refused);
        setPhase("edit");
        return;
      }
    }
    // The object changed after the preview: preview the live object again instead of sending anything.
    setPhase("checking");
    try {
      await dryRun(asked, true);
    } catch (err) {
      setPreview(null);
      setError(toApiError(err));
    } finally {
      setPhase("edit");
    }
  };

  const footer = preview ? (
    <>
      <Button disabled={busy} onClick={() => setPreview(null)}>
        {t("safeapply:actions.back")}
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => void apply(preview.changes, preview.resourceVersion)}>
        {phase === "saving" ? t("actions:dialog.working") : t("setimage:confirm")}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={close}>{t("common:actions.cancel")}</Button>
      {!alwaysPreview && (
        <Button disabled={busy || !valid} onClick={() => void runPreview()}>
          {phase === "checking" ? t("safeapply:actions.checking") : t("safeapply:actions.preview")}
        </Button>
      )}
      <Button
        variant="primary"
        disabled={busy || !valid}
        onClick={() => void (alwaysPreview ? runPreview() : apply(changes))}
      >
        {phase === "saving"
          ? t("actions:dialog.working")
          : phase === "checking" && alwaysPreview
            ? t("safeapply:actions.checking")
            : alwaysPreview
              ? t("setimage:previewAndSet")
              : t("setimage:confirm")}
      </Button>
    </>
  );

  return (
    <Dialog open title={t("setimage:title", { name: objectRef.name })} onClose={close} footer={footer}>
      <div className="set-image">
        {preview ? (
          <>
            <ChangeList changes={preview.changes} />
            {preview.renewed && (
              <p className="set-image__message set-image__message--warning" role="status">
                {t("setimage:changedSincePreview", { kind: objectRef.kind.kind, name: objectRef.name })}
              </p>
            )}
            <p className="set-image__note">{t("safeapply:actions.ready")}</p>
            <ChangePreview result={preview.result} />
          </>
        ) : (
          <>
            <p className="set-image__note">{t(`setimage:intro.${kind}`)}</p>
            {containers.length === 0 ? (
              <p>{t("setimage:none")}</p>
            ) : (
              <ContainerTable
                containers={containers}
                typed={typed}
                disabled={busy}
                onChange={(key, value) => setTyped((prev) => ({ ...prev, [key]: value }))}
              />
            )}
            {changes.length > 0 ? <ChangeList changes={changes} /> : <p className="set-image__note">{t("setimage:changes.none")}</p>}
          </>
        )}
        {error && <ErrorState error={error} />}
      </div>
    </Dialog>
  );
}

function ContainerTable({
  containers,
  typed,
  disabled,
  onChange,
}: {
  containers: ContainerImage[];
  typed: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const baseId = useId();
  return (
    <table className="set-image__table">
      <thead>
        <tr>
          <th scope="col">{t("setimage:columns.container")}</th>
          <th scope="col">{t("setimage:columns.current")}</th>
          <th scope="col">{t("setimage:columns.image")}</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c, index) => {
          const key = containerKey(c);
          const value = typed[key] ?? c.image;
          const changed = value.trim() !== c.image;
          const check = changed ? checkImage(value.trim()) : null;
          const messageId = `${baseId}-${index}`;
          const message =
            check === null
              ? null
              : !check.ok
                ? { error: true, text: t(`setimage:invalid.${check.error}`) }
                : check.warning
                  ? { error: false, text: t(`setimage:warning.${check.warning}`) }
                  : null;
          return (
            <tr key={key} className={changed ? "set-image__row set-image__row--changed" : "set-image__row"}>
              <th scope="row" className="set-image__name">
                <span>{c.name}</span>
                {c.init && <Badge tone="neutral">{t("setimage:initContainer")}</Badge>}
              </th>
              <td className="set-image__image">{c.image}</td>
              <td>
                <input
                  className="set-image__input"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={value}
                  disabled={disabled}
                  aria-label={t("setimage:imageLabel", { name: c.name })}
                  aria-invalid={check !== null && !check.ok ? true : undefined}
                  aria-describedby={message ? messageId : undefined}
                  onChange={(e) => onChange(key, e.target.value)}
                />
                {message && (
                  <p
                    id={messageId}
                    className={
                      message.error ? "set-image__message set-image__message--error" : "set-image__message set-image__message--warning"
                    }
                  >
                    {message.text}
                  </p>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ChangeList({ changes }: { changes: SetImageChange[] }) {
  const { t } = useTranslation();
  return (
    <section className="set-image__changes" aria-label={t("setimage:changes.title")}>
      <h3 className="set-image__heading">{t("setimage:changes.title")}</h3>
      <ul>
        {changes.map((c) => (
          <li key={containerKey({ name: c.container, init: c.init })}>
            {t(c.init ? "setimage:changes.lineInit" : "setimage:changes.line", {
              container: c.container,
              from: c.from,
              to: c.image,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
