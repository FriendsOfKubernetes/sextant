// Two revisions of a release compared (#209): the user values, the manifest object by object (the compare view's
// normalisation and side-by-side diff, Secrets by key names and value hashes only) and the notes. Values and the
// manifest follow the release details' rule: hidden until "Show"; notes are always visible.
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type HelmRelease, type HelmRevisionDiff, type RevisionObject } from "../../api";
import { Badge, Button, Checkbox, ErrorState, type BadgeTone } from "../../components";
import { ResizableTable } from "../../components/Table";
import { formatParts } from "../../i18n/format";
import { ObjectDiff } from "../compare/DiffView";
import { SecretKeys } from "../compare/SecretKeys";
import { TemplateDiff } from "../rollouts/TemplateDiff";
import { useLoad } from "./hooks";
import { readableRevisions, REVISION_NORMALIZE, revisionObjectState, type RevisionObjectState } from "./revisionModel";

export interface RevisionPair {
  left: number;
  right: number;
}

/** What a Show button reveals. */
const REVEAL = { values: "values", manifest: "manifest" } as const;

const TONES: Record<RevisionObjectState, BadgeTone> = { added: "success", removed: "danger", changed: "warning", same: "neutral" };

export function RevisionCompare({
  clusterId,
  release,
  history,
  pair,
  onPair,
}: {
  clusterId: ClusterId;
  release: HelmRelease;
  /** The release's history; `null` while it loads. */
  history: HelmRelease[] | null;
  pair: RevisionPair | null;
  onPair: (pair: RevisionPair) => void;
}) {
  const { t } = useTranslation();
  const revisions = useMemo(() => readableRevisions(history ?? []), [history]);
  const key = pair ? `${clusterId}|${release.namespace}|${release.name}|${pair.left}|${pair.right}` : null;
  const diff = useLoad(key, () => api.helm.revisionDiff(clusterId, release.namespace, release.name, pair!.left, pair!.right));

  if (history === null) {
    return (
      <div className="helm-muted" role="status">
        {t("helm:details.loading")}
      </div>
    );
  }
  if (revisions.length < 2 || pair === null) return <p className="helm-muted">{t("helm:compare.oneRevision")}</p>;
  return (
    <div className="helm-compare">
      <RevisionPicker revisions={revisions} pair={pair} onPair={onPair} />
      {diff.error && <ErrorState error={diff.error} onRetry={diff.reload} />}
      {!diff.data && !diff.error && (
        <div className="helm-muted" role="status">
          {t("helm:details.loading")}
        </div>
      )}
      {/* Keyed by the pair: what was shown belongs to these two revisions only. */}
      {diff.data && <CompareBody key={key} diff={diff.data} />}
    </div>
  );
}

function RevisionPicker({ revisions, pair, onPair }: { revisions: number[]; pair: RevisionPair; onPair: (p: RevisionPair) => void }) {
  const { t } = useTranslation();
  const leftId = useId();
  const rightId = useId();
  const options = revisions.map((r) => (
    <option key={r} value={r}>
      {t("helm:compare.revisionOption", { revision: r })}
    </option>
  ));
  return (
    <div className="helm-compare__picker">
      <label htmlFor={leftId}>{t("helm:compare.from")}</label>
      <select id={leftId} value={pair.left} onChange={(e) => onPair({ ...pair, left: Number(e.target.value) })}>
        {options}
      </select>
      <label htmlFor={rightId}>{t("helm:compare.to")}</label>
      <select id={rightId} value={pair.right} onChange={(e) => onPair({ ...pair, right: Number(e.target.value) })}>
        {options}
      </select>
    </div>
  );
}

function sideTitle(t: (key: string, options?: Record<string, unknown>) => string, side: HelmRelease): string {
  return t("helm:compare.side", { revision: side.revision, chart: side.chart, version: side.chartVersion });
}

function CompareBody({ diff }: { diff: HelmRevisionDiff }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<{ values: boolean; manifest: boolean }>({ values: false, manifest: false });
  const leftTitle = sideTitle(t, diff.left);
  const rightTitle = sideTitle(t, diff.right);
  return (
    <>
      <Section title={t("helm:compare.values")}>
        <Reveal what={REVEAL.values} shown={shown.values} onToggle={() => setShown((s) => ({ ...s, values: !s.values }))} />
        {shown.values &&
          (diff.leftValues === diff.rightValues ? (
            <p className="helm-muted">{t("helm:compare.valuesSame")}</p>
          ) : (
            <TemplateDiff left={diff.leftValues} right={diff.rightValues} leftTitle={leftTitle} rightTitle={rightTitle} />
          ))}
      </Section>
      <Section title={t("helm:compare.manifest")}>
        <Reveal what={REVEAL.manifest} shown={shown.manifest} onToggle={() => setShown((s) => ({ ...s, manifest: !s.manifest }))} />
        <ManifestObjects diff={diff} detailsShown={shown.manifest} leftTitle={leftTitle} rightTitle={rightTitle} />
      </Section>
      <Section title={t("helm:compare.notes")}>
        {diff.leftNotes === diff.rightNotes ? (
          <p className="helm-muted">{t("helm:compare.notesSame")}</p>
        ) : (
          <TemplateDiff left={diff.leftNotes} right={diff.rightNotes} leftTitle={leftTitle} rightTitle={rightTitle} />
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="helm-compare__section" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** The hint and the eye button, as on the release's Values and Manifest tabs. */
function Reveal({ what, shown, onToggle }: { what: "values" | "manifest"; shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="helm-reveal">
      {!shown && <span className="helm-muted">{t(`helm:compare.hidden.${what}`)}</span>}
      <Button
        iconOnly
        icon={shown ? "eyeOff" : "eye"}
        label={t(shown ? `helm:compare.hide.${what}` : `helm:compare.show.${what}`)}
        aria-pressed={shown}
        onClick={onToggle}
      />
    </div>
  );
}

function objectLabel(o: RevisionObject): string {
  const { kind, namespace, name } = o.object;
  return formatParts([kind.kind, namespace ? `${namespace}/${name}` : name]);
}

function objectKey(o: RevisionObject): string {
  return `${o.object.kind.group}/${o.object.kind.kind}|${o.object.namespace ?? ""}|${o.object.name}`;
}

/** The objects of both manifests with what happened to each; the YAML of one only once the manifest is shown. */
function ManifestObjects({
  diff,
  detailsShown,
  leftTitle,
  rightTitle,
}: {
  diff: HelmRevisionDiff;
  detailsShown: boolean;
  leftTitle: string;
  rightTitle: string;
}) {
  const { t } = useTranslation();
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => diff.objects.map((o) => ({ o, state: revisionObjectState(o) })), [diff.objects]);
  const differing = rows.filter((r) => r.state !== "same").length;
  const listed = onlyChanges ? rows.filter((r) => r.state !== "same") : rows;
  return (
    <div className="helm-compare__objects">
      <p className="helm-compare__summary" role="status">
        {differing === 0 ? t("helm:compare.manifestSame") : t("helm:compare.objectsDiffer", { count: differing })}
      </p>
      {diff.unreadable > 0 && <p className="helm-muted">{t("helm:compare.unreadable", { count: diff.unreadable })}</p>}
      {diff.truncated > 0 && <p className="helm-muted">{t("helm:compare.truncated", { count: diff.truncated })}</p>}
      <label className="helm-compare__filter">
        <Checkbox checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
        {t("helm:compare.onlyChanges")}
      </label>
      {listed.length > 0 && (
        <ResizableTable tableId="helm.revisionObjects" className="helm-table" aria-label={t("helm:compare.objectsLabel")}>
          <thead>
            <tr>
              <th>{t("helm:compare.object")}</th>
              <th>{t("helm:compare.state")}</th>
              <th>
                <span className="visually-hidden">{t("helm:compare.details")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listed.map(({ o, state }) => {
              const id = objectKey(o);
              const expanded = detailsShown && open === id;
              const label = objectLabel(o);
              return (
                <ObjectRow key={id} label={label} state={state} canOpen={detailsShown} open={expanded} onToggle={() => setOpen(expanded ? null : id)}>
                  {o.secretKeys && (
                    <SecretKeys keys={o.secretKeys} leftTitle={leftTitle} rightTitle={rightTitle} revealLeft={null} revealRight={null} />
                  )}
                  <ObjectDiff
                    kind={o.object.kind}
                    left={o.left ?? undefined}
                    right={o.right ?? undefined}
                    leftTitle={leftTitle}
                    rightTitle={rightTitle}
                    options={REVISION_NORMALIZE}
                  />
                </ObjectRow>
              );
            })}
          </tbody>
        </ResizableTable>
      )}
    </div>
  );
}

function ObjectRow({
  label,
  state,
  canOpen,
  open,
  onToggle,
  children,
}: {
  label: string;
  state: RevisionObjectState;
  canOpen: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr>
        <td className="helm-mono">{label}</td>
        <td>
          <Badge tone={TONES[state]}>{t(`helm:compare.states.${state}`)}</Badge>
        </td>
        <td>
          {canOpen && (
            <Button
              size="compact"
              icon={open ? "chevronUp" : "chevronDown"}
              aria-expanded={open}
              aria-label={t(open ? "helm:compare.hideObject" : "helm:compare.showObject", { object: label })}
              onClick={onToggle}
            >
              {open ? t("helm:compare.hideDetails") : t("helm:compare.showDetails")}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>{children}</td>
        </tr>
      )}
    </>
  );
}
