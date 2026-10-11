// ConfigMap (every key with its value) and Secret (keys with hidden values; "Show" decodes one value from base64).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import { decodeBase64 } from "../secrets";
import { Block, Fields, KINDS, link, muted, nsOf, pre, table, type FieldRow } from "../ui";

const { get, record, str } = status;

export function ConfigMapDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const data = table(
    [t("details:columns.key"), t("details:columns.value")],
    Object.entries(record(get(obj, "data"))).map(([key, value]) => [key, pre(String(value))]),
  );
  const binary = table(
    [t("details:columns.key"), t("details:columns.size")],
    Object.entries(record(get(obj, "binaryData"))).map(([key, value]) => [
      key,
      t("details:configMap.bytes", { count: Math.floor((String(value).replace(/=+$/, "").length * 3) / 4) }),
    ]),
  );
  return (
    <>
      {data && <Block title={t("details:configMap.data")}>{data}</Block>}
      {binary && <Block title={t("details:configMap.binaryData")}>{binary}</Block>}
    </>
  );
}

export function SecretDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const annotations = record(obj.metadata?.annotations);
  const rows: FieldRow[] = [
    ["type", str(get(obj, "type"))],
    ["serviceAccount", link(KINDS.serviceAccount, str(annotations["kubernetes.io/service-account.name"]), nsOf(obj))],
  ];
  const data = table(
    [t("details:columns.key"), t("details:columns.value")],
    Object.entries(record(get(obj, "data"))).map(([key, value]) => [
      key,
      <SecretValue key={key} name={key} value={String(value)} />,
    ]),
  );
  return (
    <>
      <Fields rows={rows} />
      {data && <Block title={t("details:secret.data")}>{data}</Block>}
    </>
  );
}

/** Hidden until "Show"; the state lives in the panel, so reopening the secret hides it again. */
function SecretValue({ name, value }: { name: string; value: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  let content;
  if (!shown) content = muted(t("details:secret.hidden"));
  else {
    const decoded = decodeBase64(value);
    content = decoded === null ? muted(t("details:secret.notBase64")) : pre(decoded);
  }
  const label = t(shown ? "details:secret.hideKey" : "details:secret.showKey", { key: name });
  return (
    <span className="dt-secret-value">
      {content}
      <button type="button" className="btn" aria-label={label} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
        {t(shown ? "details:secret.hide" : "details:secret.show")}
      </button>
    </span>
  );
}
