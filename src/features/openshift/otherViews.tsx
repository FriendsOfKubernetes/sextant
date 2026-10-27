// An ImageStream's details: its repositories, the lookup policy and its tags — where each points, the current image,
// when it was imported, how many images it held, a scheduled import and the import error in the registry's words.
// A Project's details: its display name, description, requester, node selector and phase, and its Namespace.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { Block, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { failedImports, projectInfo, streamRepositories, streamTags } from "./model";
import { date, LABELS, Muted, Note, refText } from "./parts";

const { get } = status;

const TAG_WRAP: ColumnWrap[] = ["nowrap", undefined, undefined, "nowrap", "nowrap", undefined];
const TABLE_TAGS = "openshiftTags";

/** `sha256:` and the first 12 hex digits of an image's digest. */
export const shortDigest = (image: string | undefined): string => (image ? image.replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1") : "");

export function ImageStreamView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const repos = streamRepositories(obj);
  const tags = streamTags(obj);
  const failed = failedImports(obj);
  const rows: FieldRow[] = [
    ["repository", repos.internal],
    ["publicRepository", repos.public],
    ["lookupLocal", get(obj, "spec", "lookupPolicy", "local") === true ? t("openshift:yes") : t("openshift:no")],
  ];
  const tagRows = tags.map((tag) => [
    tag.name,
    refText(tag.from) ?? "",
    tag.dockerImageReference ? shortDigest(tag.image) : "",
    date(tag.created),
    tag.scheduled ? t("openshift:yes") : t("openshift:no"),
    tag.importError ? (tag.importError.message ?? tag.importError.reason ?? "") : t("openshift:imagesHeld", { count: tag.history }),
  ]);
  return (
    <>
      {failed.length > 0 && <Note text={t("openshift:importFailingNote", { count: failed.length })} tone="danger" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("openshift:tags.title")}>
        {table(
          TABLE_TAGS,
          [t("openshift:tags.tag"), t("openshift:tags.from"), t("openshift:tags.image"), t("openshift:tags.created"), t("openshift:tags.scheduled"), t("openshift:tags.state")],
          tagRows,
          TAG_WRAP,
        )}
        {tags.length === 0 && <Muted text={t("openshift:tags.none")} />}
      </Block>
    </>
  );
}

export function ProjectView({ obj }: { obj: KubeObject }) {
  const info = projectInfo(obj);
  const rows: FieldRow[] = [
    ["displayName", info.displayName],
    ["description", info.description],
    ["requester", info.requester],
    ["nodeSelector", info.nodeSelector],
    ["phase", info.phase],
    ["namespace", link(KINDS.namespace, obj.metadata?.name)],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}
