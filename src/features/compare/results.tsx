// What the compare dialog shows for each kind of counterpart. Reads only: `resource_get` of both objects, the
// backend's Secret comparison (`compare_secrets`) and the Helm drift (`compare_helm_drift`).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KindRef, type KubeObject, type ObjectRef, type SecretSide } from "../../api";
import { Button, ErrorState, LoadingIndicator } from "../../components";
import { refOf } from "../../resources/refs";
import { ChangeList, ObjectDiff } from "./DiffView";
import { DriftDetails, ReleaseDrift } from "./HelmDrift";
import { useAllIgnorePaths, useLoaded } from "./hooks";
import { objectDrift } from "./model";
import { annotationOf, isSecretKind, LAST_APPLIED } from "./objects";
import type { NormalizeOptions } from "./normalize";
import { SecretKeys } from "./SecretKeys";
import type { Target } from "./TargetPicker";

function secretSide(clusterId: ClusterId, ref: ObjectRef, lastApplied = false): SecretSide {
  return { clusterId, namespace: ref.namespace ?? "", name: ref.name, lastApplied };
}

/** `text` as JSON, `null` when it is missing or not JSON. */
function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `null` when the object does not exist (any other error is thrown). */
async function getOrNull(clusterId: ClusterId, ref: ObjectRef): Promise<KubeObject | null> {
  try {
    return await api.resources.get(clusterId, ref);
  } catch (err) {
    if ((err as { code?: string }).code === "notFound") return null;
    throw err;
  }
}

export interface ObjectResultProps {
  clusterId: ClusterId;
  kind: KindRef;
  object: KubeObject;
  target: Target;
  options: NormalizeOptions;
  leftTitle: string;
  rightTitle: string;
}

export function ObjectResult({ clusterId, kind, object, target, options, leftTitle, rightTitle }: ObjectResultProps) {
  const { t } = useTranslation();
  const left = refOf(object, kind);
  const right: ObjectRef = { kind, namespace: left.namespace ? target.namespace : null, name: target.name };
  const same = clusterId === target.clusterId && left.namespace === right.namespace && left.name === right.name;
  const key = same ? null : JSON.stringify([clusterId, left, target.clusterId, right]);
  const objects = useLoaded(key, () => Promise.all([api.resources.get(clusterId, left), getOrNull(target.clusterId, right)]));
  const secret = isSecretKind(kind);
  const secrets = useLoaded(secret && objects.data?.[1] ? key : null, () =>
    api.compare.secrets(secretSide(clusterId, left), secretSide(target.clusterId, right)),
  );
  if (same) return <p className="compare-muted">{t("compare:result.sameObject")}</p>;
  if (objects.loading) return <LoadingIndicator text={t("compare:loading")} />;
  if (objects.error) return <ErrorState error={objects.error} />;
  if (!objects.data) return null;
  const [a, b] = objects.data;
  if (!b) return <p className="compare-muted">{t("compare:result.notFound", { kind: kind.kind, name: target.name })}</p>;
  return (
    <div className="compare-result">
      {secret && secrets.error && <ErrorState error={secrets.error} />}
      {secret && secrets.data && (
        <SecretKeys
          keys={secrets.data.keys}
          leftTitle={leftTitle}
          rightTitle={rightTitle}
          revealLeft={secretSide(clusterId, left)}
          revealRight={secretSide(target.clusterId, right)}
        />
      )}
      <ObjectDiff kind={kind} left={a} right={b} leftTitle={leftTitle} rightTitle={rightTitle} options={options} />
    </div>
  );
}

interface OwnResultProps {
  clusterId: ClusterId;
  kind: KindRef;
  object: KubeObject;
  options: NormalizeOptions;
}

/** The last-applied configuration against the live object; only the fields it sets count as drift. */
export function LastAppliedResult({ clusterId, kind, object, options }: OwnResultProps) {
  const { t } = useTranslation();
  const ref = refOf(object, kind);
  const key = JSON.stringify([clusterId, ref]);
  const live = useLoaded(isSecretKind(kind) ? null : key, () => api.resources.get(clusterId, ref));
  const secret = useLoaded(isSecretKind(kind) ? key : null, () =>
    api.compare.secrets(secretSide(clusterId, ref, true), secretSide(clusterId, ref)),
  );
  const leftTitle = t("compare:side.lastApplied");
  const rightTitle = t("compare:side.live");
  if (live.loading || secret.loading) return <LoadingIndicator text={t("compare:loading")} />;
  const error = live.error ?? secret.error;
  if (error) return <ErrorState error={error} />;
  if (secret.data) {
    if (secret.data.left !== "found") return <p className="compare-muted">{t("compare:dialog.unavailable.lastApplied")}</p>;
    return (
      <SecretKeys keys={secret.data.keys} leftTitle={leftTitle} rightTitle={rightTitle} revealLeft={null} revealRight={secretSide(clusterId, ref)} />
    );
  }
  if (!live.data) return null;
  const text = annotationOf(live.data, LAST_APPLIED);
  const desired = parseJson(text);
  if (typeof desired !== "object" || desired === null) {
    return <p className="compare-muted">{t("compare:dialog.unavailable.lastApplied")}</p>;
  }
  const changes = objectDrift(desired, live.data, kind, options);
  return (
    <div className="compare-result">
      <p className="compare-summary" role="status">
        {changes.length === 0 ? t("compare:result.noDrift") : t("compare:result.drift", { count: changes.length })}
      </p>
      <ChangeList changes={changes} leftTitle={leftTitle} rightTitle={rightTitle} label={t("compare:result.driftLabel")} />
      <ObjectDiff kind={kind} left={desired} right={live.data} leftTitle={leftTitle} rightTitle={rightTitle} options={options} />
    </div>
  );
}

/** The object in its Helm release's stored manifest against the live one, and on request the whole release. */
export function HelmResult({
  clusterId,
  kind,
  object,
  release,
  options,
  hideDefaults,
}: OwnResultProps & { release: { name: string; namespace: string }; hideDefaults: boolean }) {
  const { t } = useTranslation();
  const [whole, setWhole] = useState(false);
  const ignorePaths = useAllIgnorePaths();
  const ref = refOf(object, kind);
  const drift = useLoaded(JSON.stringify([clusterId, release]), () => api.compare.helmDrift(clusterId, release.namespace, release.name));
  if (drift.loading) return <LoadingIndicator text={t("compare:loading")} />;
  if (drift.error) return <ErrorState error={drift.error} />;
  if (!drift.data) return null;
  const entry = drift.data.objects.find(
    (o) =>
      o.object.kind.group === kind.group &&
      o.object.kind.kind === kind.kind &&
      o.object.name === ref.name &&
      (o.object.namespace ?? null) === (ref.namespace ?? null),
  );
  return (
    <div className="compare-result">
      {entry ? (
        <DriftDetails clusterId={clusterId} entry={entry} options={options} />
      ) : (
        <p className="compare-muted">{t("compare:result.notInRelease", { name: release.name })}</p>
      )}
      <Button icon={whole ? "chevronUp" : "chevronDown"} aria-expanded={whole} onClick={() => setWhole(!whole)}>
        {whole ? t("compare:result.hideRelease") : t("compare:result.showRelease", { name: release.name })}
      </Button>
      {whole && <ReleaseDrift clusterId={clusterId} drift={drift.data} hideDefaults={hideDefaults} ignorePaths={ignorePaths} />}
    </div>
  );
}
