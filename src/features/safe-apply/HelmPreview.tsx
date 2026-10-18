// "Preview changes" of a Helm upgrade or install (#141): the release's current manifest against the one Helm would
// apply, side by side (like `helm diff upgrade`), with Secrets shown without their values. `useHelmPreview` keeps the
// preview of the dialog's current input; a preview of other input is stale and not offered as one.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, newStreamId, toApiError, type ApiError, type HelmManifestDiff } from "../../api";
import { Button, ErrorState } from "../../components";
import { formatList } from "../../i18n/format";
import { TemplateDiff } from "../rollouts/TemplateDiff";

export interface HelmPreviewState {
  /** The preview of the current input; `null` before one or once the input changed. */
  diff: HelmManifestDiff | null;
  loading: boolean;
  error: ApiError | null;
  /** Renders the preview of the current input. */
  run: () => void;
}

/**
 * A preview of `render(previewId)` for `input` (any text that changes when what would be rendered changes). A render
 * still running when another starts or the dialog closes is stopped (`helm_preview_stop`), which kills its `helm`.
 */
export function useHelmPreview(input: string, render: (previewId: string) => Promise<HelmManifestDiff>): HelmPreviewState {
  const [state, setState] = useState<{ input: string; diff: HelmManifestDiff | null; error: ApiError | null }>({
    input: "",
    diff: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  const latest = useRef(render);
  latest.current = render;
  const current = useRef(input);
  current.current = input;
  /** The id of the render under way, if any. */
  const running = useRef<string | null>(null);
  useEffect(
    () => () => {
      const id = running.current;
      running.current = null;
      if (id) void api.helm.previewStop(id).catch(() => undefined);
    },
    [],
  );
  const run = useCallback(() => {
    const previous = running.current;
    if (previous) void api.helm.previewStop(previous).catch(() => undefined);
    const id = newStreamId();
    running.current = id;
    const asked = current.current;
    setLoading(true);
    const mine = () => running.current === id;
    latest
      .current(id)
      .then(
        (diff) => mine() && setState({ input: asked, diff, error: null }),
        (err: unknown) => mine() && setState({ input: asked, diff: null, error: toApiError(err) }),
      )
      .finally(() => {
        if (!mine()) return;
        running.current = null;
        setLoading(false);
      });
  }, []);
  const fresh = state.input === input;
  return { diff: fresh ? state.diff : null, error: fresh ? state.error : null, loading, run };
}

/** The "Preview changes" button and, once rendered, the two manifests. `required`: the cluster asks for a preview. */
export function HelmPreview({
  release,
  preview,
  required,
  canRun = true,
}: {
  release: string;
  preview: HelmPreviewState;
  required: boolean;
  /** False while the input cannot be rendered (no release name yet). */
  canRun?: boolean;
}) {
  const { t } = useTranslation();
  const { diff, error, loading, run } = preview;
  return (
    <div className="safe-apply-helm">
      <div className="safe-apply-helm__bar">
        <Button disabled={loading || !canRun} onClick={run}>
          {loading ? t("safeapply:actions.checking") : t("safeapply:actions.preview")}
        </Button>
        {required && !diff && <span className="action-dialog__hint">{t("safeapply:actions.required")}</span>}
      </div>
      {error && <ErrorState error={error} title={t("safeapply:helm.failed")} />}
      {diff && <HelmDiff release={release} diff={diff} />}
    </div>
  );
}

function HelmDiff({ release, diff }: { release: string; diff: HelmManifestDiff }) {
  const { t } = useTranslation();
  return (
    <div className="safe-apply-preview" role="region" aria-label={t("safeapply:diff.title")}>
      <div className="safe-apply-preview__notes">
        {diff.current === "" && <p>{t("safeapply:helm.noRelease")}</p>}
        {diff.current !== "" && diff.current === diff.proposed && diff.secretChanges.length === 0 && (
          <p>{t("safeapply:helm.same")}</p>
        )}
        {diff.secretChanges.length > 0 && <p>{t("safeapply:diff.secretHidden")}</p>}
        {diff.secretChanges.map((change) => (
          <div key={change.object}>
            {change.keys.added.length > 0 && (
              <p>{t("safeapply:helm.secretAdded", { object: change.object, keys: formatList(change.keys.added) })}</p>
            )}
            {change.keys.changed.length > 0 && (
              <p>{t("safeapply:helm.secretChanged", { object: change.object, keys: formatList(change.keys.changed) })}</p>
            )}
            {change.keys.removed.length > 0 && (
              <p>{t("safeapply:helm.secretRemoved", { object: change.object, keys: formatList(change.keys.removed) })}</p>
            )}
          </div>
        ))}
        {diff.unreadable > 0 && <p>{t("safeapply:helm.unreadable", { count: diff.unreadable })}</p>}
        {diff.clientSide && <p className="safe-apply-preview__warning">{t("safeapply:helm.clientSide")}</p>}
        <p>{t("safeapply:helm.noHooks")}</p>
      </div>
      <TemplateDiff
        left={diff.current}
        right={diff.proposed}
        leftTitle={t("safeapply:helm.current", { release })}
        rightTitle={t("safeapply:helm.proposed", { release })}
      />
    </div>
  );
}
