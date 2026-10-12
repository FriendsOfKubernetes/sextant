// ConfigMap (every key with its value) and Secret (keys only: the backend sends no values; "Show" reads one).
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type KubeObject } from "../../../api";
import { status } from "../../../resources";
import { Block, Fields, KINDS, link, muted, nsOf, pre, table, type FieldRow } from "../ui";
import type { KindViewProps } from "./index";

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

export function SecretDetails({ obj, clusterId }: KindViewProps) {
  const { t } = useTranslation();
  const annotations = record(obj.metadata?.annotations);
  const namespace = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  const rows: FieldRow[] = [
    ["type", str(get(obj, "type"))],
    ["serviceAccount", link(KINDS.serviceAccount, str(annotations["kubernetes.io/service-account.name"]), nsOf(obj))],
  ];
  // The backend sends the keys with empty values; each value is read on its own when asked for.
  const data = table(
    [t("details:columns.key"), t("details:columns.value")],
    Object.keys(record(get(obj, "data"))).map((field) => [
      field,
      <SecretValue key={field} clusterId={clusterId} namespace={namespace} name={name} field={field} />,
    ]),
  );
  return (
    <>
      <Fields rows={rows} />
      {data && <Block title={t("details:secret.data")}>{data}</Block>}
    </>
  );
}

type ValueState =
  | { phase: "hidden" }
  | { phase: "loading" }
  | { phase: "shown"; value: string }
  | { phase: "failed"; error: ApiError };

interface SecretValueProps {
  clusterId: ClusterId;
  namespace: string;
  name: string;
  field: string;
}

/**
 * Hidden until "Show", which reads this one value from the backend (`secret_value`); "Hide" forgets it. The state
 * lives in the panel, so reopening the secret hides it again.
 */
function SecretValue({ clusterId, namespace, name, field }: SecretValueProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ValueState>({ phase: "hidden" });
  // A reply that arrives after "Hide" (or after a newer "Show") is dropped.
  const request = useRef(0);

  const toggle = () => {
    const id = ++request.current;
    if (state.phase !== "hidden") {
      setState({ phase: "hidden" });
      return;
    }
    setState({ phase: "loading" });
    api.resources.secretValue(clusterId, namespace, name, field).then(
      (value) => {
        if (request.current === id) setState({ phase: "shown", value });
      },
      (err: unknown) => {
        if (request.current === id) setState({ phase: "failed", error: toApiError(err) });
      },
    );
  };

  let content;
  if (state.phase === "hidden") content = muted(t("details:secret.hidden"));
  else if (state.phase === "loading") content = muted(t("details:secret.loading"));
  else if (state.phase === "shown") content = pre(state.value);
  else content = muted(t("details:secret.unreadable", { message: state.error.message }));
  const open = state.phase !== "hidden";
  const label = t(open ? "details:secret.hideKey" : "details:secret.showKey", { key: field });
  return (
    <span className="dt-secret-value">
      {content}
      <button type="button" className="btn" aria-label={label} aria-pressed={open} onClick={toggle}>
        {t(open ? "details:secret.hide" : "details:secret.show")}
      </button>
    </span>
  );
}
