import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { ErrorState } from "../../components";
import { getDetailsSections, useDetailsObject } from "./registry";

/** Panel that slides in from the right with the registered sections for the selected object. */
export function DetailsPanel({ clusterId, objectRef }: { clusterId: ClusterId; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const closeDetails = useAppStore((s) => s.closeDetails);
  const { obj, loading, error } = useDetailsObject(clusterId, objectRef);
  const sections = getDetailsSections(objectRef.kind);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[aria-modal='true']")) closeDetails();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDetails]);

  return (
    <aside className="details" aria-label={t("common:layout.details")}>
      <header className="details__header">
        <div className="details__heading">
          <div className="details__kind">{objectRef.kind.kind}</div>
          <h2 className="details__name">{objectRef.name}</h2>
          {objectRef.namespace && (
            <div className="details__namespace">{t("common:details.inNamespace", { namespace: objectRef.namespace })}</div>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label={t("common:actions.closeDetails")} onClick={closeDetails}>
          ×
        </button>
      </header>
      <div className="details__body">
        {error && <ErrorState error={error} />}
        {loading && !obj && !error && <div className="details__loading">{t("common:details.loading")}</div>}
        {sections.map(({ id, Component }) => (
          <section key={id} className="details__section" data-section={id}>
            <Component clusterId={clusterId} objectRef={objectRef} obj={obj} />
          </section>
        ))}
      </div>
    </aside>
  );
}
