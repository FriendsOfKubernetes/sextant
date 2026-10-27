// "Accessible namespaces" in the cluster settings (#285): the known namespaces of the cluster (`known.ts`), added and
// removed here as well as from the namespace filter, with what the access check (`accessStore.ts`) says of each while
// the cluster is connected, and the namespaces it found (the context's, the ServiceAccount's, OpenShift projects).
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError } from "../../api";
import { Badge, Button, ErrorState } from "../../components";
import { formatDateTime, formatList } from "../../i18n/format";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { useClusterState } from "../clusters/hooks";
import type { FoundBy, NamespaceAccess } from "./access";
import { refreshAccess, useAccess } from "./accessStore";
import { addKnownNamespaces, forgetKnownNamespaces, isNamespaceName, MAX_KNOWN_NAMESPACES, useKnownNamespaces } from "./known";

export function AccessibleNamespacesSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const known = useKnownNamespaces(clusterId);
  const access = useAccess(clusterId);
  const connected = useClusterState(clusterId).state === "connected";
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const restricted = access.listNamespaces === false;

  const run = async (change: Promise<void>) => {
    try {
      await change;
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const names = text
      .split(/[\s,]+/)
      .map((n) => n.trim())
      .filter(Boolean);
    const bad = names.find((n) => !isNamespaceName(n));
    if (bad !== undefined) {
      setInvalid(bad);
      return;
    }
    setInvalid(null);
    setText("");
    void run(addKnownNamespaces(clusterId, names));
  };

  const mark = (ns: string) => {
    const value: NamespaceAccess | undefined = restricted ? access.namespaces.get(ns) : undefined;
    if (value === "accessible") return <Badge tone="success">{t("namespaces:mark.accessible")}</Badge>;
    if (value === "noAccess") return <Badge tone="warning">{t("namespaces:mark.noAccess")}</Badge>;
    return null;
  };
  const sources = (by: readonly FoundBy[]) => formatList(by.map((b) => t(`namespaces:found.${b}`)));
  const found = [...access.found].filter(([ns]) => !known.includes(ns)).sort(([a], [b]) => a.localeCompare(b));

  let status: string;
  if (!connected) status = t("namespaces:settings.notConnected");
  else if (access.listNamespaces === true) status = t("namespaces:settings.unrestricted");
  else if (restricted) status = t("namespaces:settings.restricted");
  else if (access.status === "checking") status = t("namespaces:check.checking");
  else status = t("namespaces:settings.unknown");

  return (
    <div className="ns-known">
      <p className="ns-known__hint">{t("namespaces:settings.hint")}</p>
      <p role="status">{status}</p>
      {connected && access.username && <p>{t("namespaces:settings.username", { user: access.username })}</p>}
      {connected && access.error && <ErrorState error={access.error} />}
      {connected && (
        <div>
          <Button
            size="compact"
            icon="refresh"
            disabled={access.status === "checking"}
            onClick={() => void refreshAccess(clusterId)}
          >
            {access.status === "checking" ? t("namespaces:check.checking") : t("namespaces:check.again")}
          </Button>
          {access.checkedAt !== null && access.status !== "checking" && (
            <span className="ns-known__hint"> {t("namespaces:check.checkedAt", { time: formatDateTime(access.checkedAt) })}</span>
          )}
        </div>
      )}
      <form className="ns-known__add" onSubmit={add}>
        <label htmlFor={inputId}>{t("namespaces:settings.addLabel")}</label>
        <input
          id={inputId}
          type="text"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid !== null || undefined}
          aria-describedby={invalid !== null ? hintId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(null);
          }}
        />
        <Button type="submit" disabled={!text.trim()}>
          {t("namespaces:settings.add")}
        </Button>
      </form>
      {invalid !== null && (
        <p id={hintId} className="ns-filter__invalid" role="alert">
          {t("namespaces:invalidName", { name: invalid })}
        </p>
      )}
      <p className="ns-known__hint">{t("namespaces:settings.cap", { max: MAX_KNOWN_NAMESPACES })}</p>
      {known.length === 0 ? (
        <p className="ns-known__hint">{t("namespaces:settings.empty")}</p>
      ) : (
        <ul className="ns-known__list" aria-label={t("namespaces:settings.title")}>
          {known.map((ns) => (
            <li key={ns} className="ns-known__item">
              <span>{ns}</span>
              {mark(ns)}
              <Button
                size="compact"
                iconOnly
                icon="close"
                label={t("namespaces:settings.remove", { namespace: ns })}
                onClick={() => void run(forgetKnownNamespaces(clusterId, [ns]))}
              />
            </li>
          ))}
        </ul>
      )}
      {found.length > 0 && (
        <>
          <h4 className="ns-known__heading">{t("namespaces:settings.found")}</h4>
          <ul className="ns-known__list" aria-label={t("namespaces:settings.found")}>
            {found.map(([ns, by]) => (
              <li key={ns} className="ns-known__item">
                <span title={t("namespaces:found.title", { sources: sources(by) })}>{ns}</span>
                {mark(ns)}
                <Button
                  size="compact"
                  aria-label={t("namespaces:settings.keepNamed", { namespace: ns })}
                  onClick={() => void run(addKnownNamespaces(clusterId, [ns]))}
                >
                  {t("namespaces:settings.keep")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <ErrorState error={error} />}
    </div>
  );
}
