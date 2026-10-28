import { useDetailsDisclosure } from "../../layout/details/disclosure";
// A BuildConfig's details: strategy and builder image, source (a Git URI without userinfo, query or fragment; an
// inline Dockerfile only as "set"; the source Secret by name), output, run policy, triggers by type (a webhook's secret
// never shown) and its builds — labelled with its name, newest first. "Start build" is an action of the panel.
// A Build's details: its phase and why it failed, its BuildConfig, source revision, what started it, times and
// duration, output image, the build pod with its logs (`openshift.io/build.pod-name`, else `<build>-build`) and the
// log snippet the build controller keeps.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Button } from "../../components";
import { status } from "../../resources";
import { cleanText } from "../../resources/uri";
import { DurationText } from "../argo-workflows/columns";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { openLogsTab } from "../logs";
import { BuildPhaseText } from "./columns";
import { useConfigBuilds, usePod } from "./hooks";
import {
  bcPaused,
  bcTriggers,
  buildConfigOf,
  buildDurationMs,
  buildNumber,
  buildOutput,
  buildPhase,
  buildPodName,
  buildReason,
  buildsOf,
  buildSource,
  buildStrategy,
  imageStreamOf,
  isFailedBuild,
  triggeredBy,
  type Ref,
} from "./model";
import { code, date, LABELS, Muted, Note, refText, TYPES } from "./parts";

const { get, num, str } = status;

/** Builds listed in one view; the rest are counted. */
export const MAX_LISTED_BUILDS = 20;

const BUILD_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", undefined];
const TABLE_BUILDS = "openshiftBuilds";

/** An ImageStreamTag reference as a link to its ImageStream; another reference as text. */
function imageRef(ref: Ref | undefined, ns: string | null) {
  const stream = imageStreamOf(ref);
  return stream ? link(TYPES.imageStream, stream, ref?.namespace ?? ns, ref?.name) : refText(ref);
}

export function BuildConfigView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const source = buildSource(obj);
  const strategy = buildStrategy(obj);
  const open = useDetailsDisclosure("openshift:builds.title")?.open ?? true;
  const listed = useConfigBuilds(clusterId, open ? obj : null);
  const builds = buildsOf(obj, listed.items);
  const rows: FieldRow[] = [
    ["strategy", strategy.type],
    ["builderImage", imageRef(strategy.from, ns)],
    ["sourceType", source.type],
    ["gitUri", source.uri],
    ["gitRef", source.ref],
    ["contextDir", source.contextDir],
    ["dockerfile", source.dockerfile ? t("openshift:set") : null],
    ["sourceSecret", link(KINDS.secret, source.secret, ns)],
    ["output", imageRef(buildOutput(obj), ns)],
    ["runPolicy", str(get(obj, "spec", "runPolicy"))],
    ["lastVersion", num(get(obj, "status", "lastVersion"))?.toString()],
    ["triggers", chips(bcTriggers(obj).map((tr) => (tr.from ? `${tr.type}: ${tr.from.name}` : tr.type)))],
  ];
  const buildRows = builds.slice(0, MAX_LISTED_BUILDS).map((b) => [
    link(TYPES.build, b.metadata?.name, ns),
    <BuildPhaseText key="p" obj={b} />,
    <DurationText key="d" ms={buildDurationMs(b)} />,
    date(str(get(b, "status", "startTimestamp"))),
    isFailedBuild(b) ? (buildReason(b) ?? "") : "",
  ]);
  return (
    <>
      {bcPaused(obj) && <Muted text={t("openshift:buildPausedNote")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block id="openshift:builds.title" title={t("openshift:builds.title")}>
        {listed.loading && <Muted text={t("openshift:loading")} />}
        {listed.error && <Muted text={t("openshift:listError")} />}
        {table(
          TABLE_BUILDS,
          [t("openshift:builds.name"), t("openshift:builds.phase"), t("openshift:builds.duration"), t("openshift:builds.started"), t("openshift:builds.reason")],
          buildRows,
          BUILD_WRAP,
        )}
        {!listed.loading && !listed.error && builds.length === 0 && <Muted text={t("openshift:builds.none")} />}
        {builds.length > MAX_LISTED_BUILDS && <Muted text={t("openshift:more", { count: builds.length - MAX_LISTED_BUILDS })} />}
        {listed.truncated && <Muted text={t("openshift:truncated")} />}
      </Block>
    </>
  );
}

export function BuildView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const podName = buildPodName(obj);
  const { pod, loading } = usePod(clusterId, ns, podName);
  const source = buildSource(obj);
  const reason = buildReason(obj);
  const snippet = cleanText(str(get(obj, "status", "logSnippet")));
  const rows: FieldRow[] = [
    ["status", <BuildPhaseText key="s" obj={obj} />],
    ["reason", str(get(obj, "status", "reason"))],
    ["buildConfig", link(TYPES.buildConfig, buildConfigOf(obj), ns)],
    ["number", buildNumber(obj)?.toString()],
    ["strategy", buildStrategy(obj).type],
    ["gitUri", source.uri],
    ["commit", str(get(obj, "spec", "revision", "git", "commit"))],
    ["triggeredBy", chips(triggeredBy(obj))],
    ["started", date(str(get(obj, "status", "startTimestamp")))],
    ["completed", date(str(get(obj, "status", "completionTimestamp")))],
    ["duration", <DurationText key="d" ms={buildDurationMs(obj)} />],
    ["output", imageRef(buildOutput(obj), ns)],
    ["outputImage", str(get(obj, "status", "outputDockerImageReference"))],
    ["imageDigest", str(get(obj, "status", "output", "to", "imageDigest"))],
    ["buildPod", link(KINDS.pod, podName, ns)],
  ];
  const phase = buildPhase(obj);
  return (
    <>
      {isFailedBuild(obj) && reason && <Note text={reason} tone="danger" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block id="openshift:logs.title"
        title={t("openshift:logs.title")}
        actions={
          pod ? (
            <Button size="compact" icon="logs" onClick={() => void openLogsTab(clusterId, pod)}>
              {t("openshift:logs.open")}
            </Button>
          ) : undefined
        }
      >
        {!pod && !loading && <Muted text={phase === "New" ? t("openshift:logs.notYet") : t("openshift:logs.gone")} />}
        {snippet && code(snippet)}
      </Block>
    </>
  );
}
