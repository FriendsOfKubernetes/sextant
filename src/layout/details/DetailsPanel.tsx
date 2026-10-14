import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { ErrorState, Icon, Tabs } from "../../components";
import { getDetailsSections, useDetailsObject, useDetailsSectionsVersion, type DetailsSectionDef } from "./registry";

const OVERVIEW = "overview";

/**
 * Panel that slides in from the right with the registered sections for the selected object. When a section placed as
 * a tab applies (an extension's), the panel gets a tab strip: "Overview" with the stacked sections, then those tabs.
 */
export function DetailsPanel({ clusterId, objectRef }: { clusterId: ClusterId; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const closeDetails = useAppStore((s) => s.closeDetails);
  const { obj, loading, error } = useDetailsObject(clusterId, objectRef);
  useDetailsSectionsVersion();
  const all = getDetailsSections(objectRef.kind);
  const sections = all.filter((s) => s.placement !== "tab");
  const tabs = all.filter((s) => s.placement === "tab");
  const [tab, setTab] = useState(OVERVIEW);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open popup or dialog takes Escape for itself.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[aria-modal='true']")) closeDetails();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDetails]);

  const state = (
    <>
      {error && <ErrorState error={error} />}
      {loading && !obj && !error && <div className="details__loading">{t("common:details.loading")}</div>}
    </>
  );
  const stacked = sections.map(({ id, Component }) => (
    <section key={id} className="details__section" data-section={id}>
      <Component clusterId={clusterId} objectRef={objectRef} obj={obj} />
    </section>
  ));
  // A tab that went away (its extension was disabled) leaves the panel on "Overview".
  const openTab = tabs.find((s) => s.id === tab);

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
          <Icon name="close" />
        </button>
      </header>
      {tabs.length === 0 ? (
        <div className="details__body">
          {state}
          {stacked}
        </div>
      ) : (
        <Tabs
          className="details__tabs"
          label={t("mcp:extensionHost.detailsTabs")}
          tabs={[
            { id: OVERVIEW, label: t("mcp:extensionHost.overview") },
            ...tabs.map((s) => ({ id: s.id, label: s.label ?? s.id })),
          ]}
          selected={openTab ? tab : OVERVIEW}
          onSelect={setTab}
        >
          {openTab ? (
            <TabBody section={openTab} clusterId={clusterId} objectRef={objectRef} obj={obj} />
          ) : (
            <div className="details__body">
              {state}
              {stacked}
            </div>
          )}
        </Tabs>
      )}
    </aside>
  );
}

function TabBody({
  section,
  clusterId,
  objectRef,
  obj,
}: {
  section: DetailsSectionDef;
  clusterId: ClusterId;
  objectRef: ObjectRef;
  obj: KubeObject | null;
}) {
  const { Component } = section;
  return (
    <div className="details__body details__body--tab" data-section={section.id}>
      <Component clusterId={clusterId} objectRef={objectRef} obj={obj} />
    </div>
  );
}
