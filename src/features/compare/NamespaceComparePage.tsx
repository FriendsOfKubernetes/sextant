// "Compare namespaces" (#156): two (cluster, namespace) sides, chosen kinds; objects only on one side, objects that
// differ and the same ones, with the diff of one object on click. Read-only; bounded lists (`COMPARE_LIMIT` per kind
// and side), one comparison per click, no watches.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef, NamespaceSide, SecretNamespaceComparison } from "../../api";
import type { PageProps } from "../../layout/pages";
import { Badge, Button, Checkbox, ErrorState, LoadingIndicator, type BadgeTone } from "../../components";
import { formatParts } from "../../i18n/format";
import { kindKey } from "../../resources/refs";
import { ObjectDiff } from "./DiffView";
import { useAllIgnorePaths, useClusterChoices, useLoaded } from "./hooks";
import { COMPARE_KINDS, COMPARE_LIMIT } from "./kinds";
import { BUCKETS, countBuckets, type Bucket, type CompareRow } from "./model";
import { failedKinds, resultRows, runNamespaceCompare, truncatedKinds, type NamespaceRequest } from "./namespaceRun";
import { isSecretKind } from "./objects";
import { IgnorePathsEditor } from "./Options";
import { SecretKeys } from "./SecretKeys";
import { ConnectOther } from "./TargetPicker";

export const COMPARE_PAGE_ID = "compareNamespaces";

const TONES: Record<Bucket, BadgeTone> = { onlyLeft: "warning", onlyRight: "warning", differ: "danger", same: "success" };

export function NamespaceComparePage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const [left, setLeft] = useState<NamespaceSide>({ clusterId, namespace: "default" });
  const [right, setRight] = useState<NamespaceSide>({ clusterId, namespace: "" });
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(COMPARE_KINDS.map(kindKey)));
  const [request, setRequest] = useState<NamespaceRequest | null>(null);
  const [hideDefaults, setHideDefaults] = useState(false);
  const [shown, setShown] = useState<Set<Bucket>>(() => new Set<Bucket>(["onlyLeft", "onlyRight", "differ"]));
  const [selected, setSelected] = useState<string | null>(null);
  const choices = useClusterChoices();
  const ignorePaths = useAllIgnorePaths();
  const connected = (side: NamespaceSide) => choices.some((c) => c.id === side.clusterId && c.connected);
  const valid = (side: NamespaceSide) => connected(side) && /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(side.namespace);
  const chosen = COMPARE_KINDS.filter((k) => kinds.has(kindKey(k)));
  const ready = valid(left) && valid(right) && chosen.length > 0;
  const result = useLoaded(request ? JSON.stringify(request) : null, () => runNamespaceCompare(request as NamespaceRequest));
  const rows = useMemo(() => (result.data ? resultRows(result.data, hideDefaults, ignorePaths) : []), [result.data, hideDefaults, ignorePaths]);
  const counts = countBuckets(rows);
  const visible = rows.filter((r) => shown.has(r.bucket));
  const label = (side: NamespaceSide) => formatParts([choices.find((c) => c.id === side.clusterId)?.label ?? side.clusterId, side.namespace]);
  const rowKey = (row: CompareRow) => `${kindKey(row.kind)}|${row.name}`;
  const selectedRow = visible.find((r) => rowKey(r) === selected) ?? null;

  return (
    <div className="compare-page">
      <h1>{t("compare:page.title")}</h1>
      <p className="compare-muted">{t("compare:page.hint", { max: COMPARE_LIMIT })}</p>
      <form
        className="compare-page__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          setSelected(null);
          setRequest({ left, right, kinds: chosen });
        }}
      >
        <div className="compare-sides">
          <SidePicker title={t("compare:page.left")} value={left} onChange={setLeft} />
          <SidePicker title={t("compare:page.right")} value={right} onChange={setRight} />
        </div>
        <ConnectOther choices={choices.filter((c) => !c.connected)} />
        <fieldset className="compare-kinds">
          <legend>{t("compare:page.kinds")}</legend>
          {COMPARE_KINDS.map((k) => (
            <label key={kindKey(k)} className="compare-check">
              <Checkbox
                checked={kinds.has(kindKey(k))}
                onChange={(e) => {
                  const next = new Set(kinds);
                  if (e.target.checked) next.add(kindKey(k));
                  else next.delete(kindKey(k));
                  setKinds(next);
                }}
              />
              {k.kind}
            </label>
          ))}
        </fieldset>
        <label className="compare-check" title={t("compare:options.hideDefaultsHint")}>
          <Checkbox checked={hideDefaults} onChange={(e) => setHideDefaults(e.target.checked)} />
          {t("compare:options.hideDefaults")}
        </label>
        <Button type="submit" variant="primary" disabled={!ready || result.loading}>
          {t("compare:dialog.compare")}
        </Button>
      </form>
      {result.loading && <LoadingIndicator text={t("compare:loading")} />}
      {result.error && <ErrorState error={result.error} />}
      {result.data && request && (
        <section className="compare-page__result" aria-label={t("compare:page.result")}>
          {failedKinds(result.data).map(({ side, list }) => (
            <p key={`${side}|${kindKey(list.kind)}`} className="compare-error">
              {t(side === "left" ? "compare:page.failedLeft" : "compare:page.failedRight", {
                kind: list.kind.kind,
                message: list.error?.message ?? "",
              })}
            </p>
          ))}
          {truncatedKinds(result.data).length > 0 && (
            <p className="compare-muted">{t("compare:page.truncated", { max: COMPARE_LIMIT })}</p>
          )}
          {result.data.secretsError && (
            <p className="compare-error">{t("compare:page.secretsFailed", { message: result.data.secretsError.message })}</p>
          )}
          {result.data.secrets?.truncated && <p className="compare-muted">{t("compare:page.secretsTruncated", { max: COMPARE_LIMIT })}</p>}
          <div className="compare-buckets" role="group" aria-label={t("compare:page.filter")}>
            {BUCKETS.map((b) => (
              <label key={b} className="compare-check">
                <Checkbox
                  checked={shown.has(b)}
                  onChange={(e) => {
                    const next = new Set(shown);
                    if (e.target.checked) next.add(b);
                    else next.delete(b);
                    setShown(next);
                  }}
                />
                {t(`compare:buckets.${b}`, { count: counts[b] })}
              </label>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="compare-muted">{t("compare:page.nothing")}</p>
          ) : (
            <table className="compare-table" aria-label={t("compare:page.objects")}>
              <thead>
                <tr>
                  <th>{t("compare:page.kind")}</th>
                  <th>{t("compare:target.name")}</th>
                  <th>{t("compare:page.state")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={rowKey(row)} className={rowKey(row) === selected ? "compare-row compare-row--selected" : "compare-row"}>
                    <td>{row.kind.kind}</td>
                    <td>
                      <button type="button" className="compare-link" aria-pressed={rowKey(row) === selected} onClick={() => setSelected(rowKey(row) === selected ? null : rowKey(row))}>
                        {row.name}
                      </button>
                    </td>
                    <td>
                      <Badge tone={TONES[row.bucket]}>{t(`compare:states.${row.bucket}`)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {selectedRow && (
            <RowDetails row={selectedRow} request={request} secrets={result.data.secrets} hideDefaults={hideDefaults} ignorePaths={ignorePaths} label={label} />
          )}
        </section>
      )}
    </div>
  );
}

function SidePicker({ title, value, onChange }: { title: string; value: NamespaceSide; onChange: (value: NamespaceSide) => void }) {
  const { t } = useTranslation();
  const connected = useClusterChoices().filter((c) => c.connected);
  return (
    <fieldset className="compare-side">
      <legend>{title}</legend>
      <label className="compare-field">
        <span>{t("compare:target.cluster")}</span>
        <select
          className="compare-input"
          value={connected.some((c) => c.id === value.clusterId) ? value.clusterId : ""}
          onChange={(e) => onChange({ ...value, clusterId: e.target.value })}
        >
          {!connected.some((c) => c.id === value.clusterId) && <option value="" disabled />}
          {connected.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="compare-field">
        <span>{t("compare:target.namespace")}</span>
        <input className="compare-input" value={value.namespace} onChange={(e) => onChange({ ...value, namespace: e.target.value.trim() })} />
      </label>
    </fieldset>
  );
}

function RowDetails({
  row,
  request,
  secrets,
  hideDefaults,
  ignorePaths,
  label,
}: {
  row: CompareRow;
  request: NamespaceRequest;
  secrets: SecretNamespaceComparison | null;
  hideDefaults: boolean;
  ignorePaths: Record<string, string[]>;
  label: (side: NamespaceSide) => string;
}) {
  const kind: KindRef = row.kind;
  const options = useMemo(() => ({ hideDefaults, ignorePaths: ignorePaths[kindKey(kind)] ?? [] }), [hideDefaults, ignorePaths, kind]);
  const leftTitle = label(request.left);
  const rightTitle = label(request.right);
  const keys = isSecretKind(kind) ? secrets?.secrets.find((s) => s.name === row.name)?.keys : undefined;
  const reveal = (side: NamespaceSide) => ({ clusterId: side.clusterId, namespace: side.namespace, name: row.name });
  return (
    <div className="compare-row-details">
      <h2>{formatParts([kind.kind, row.name])}</h2>
      <IgnorePathsEditor kind={kind} />
      {keys && <SecretKeys keys={keys} leftTitle={leftTitle} rightTitle={rightTitle} revealLeft={reveal(request.left)} revealRight={reveal(request.right)} />}
      <ObjectDiff kind={kind} left={row.left} right={row.right} leftTitle={leftTitle} rightTitle={rightTitle} options={options} />
    </div>
  );
}
