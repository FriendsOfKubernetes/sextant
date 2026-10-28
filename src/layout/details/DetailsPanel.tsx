import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { ErrorState, Icon, Tabs } from "../../components";
import { DetailsDisclosureProvider, DetailsSectionControls, DetailsSectionScope } from "./disclosure";
import {
  getDetailsHeaderTools,
  getDetailsSections,
  useDetailsObject,
  useDetailsSectionsVersion,
  type DetailsHeaderPlace,
  type DetailsSectionDef,
} from "./registry";

const OVERVIEW = "overview";
const AFTER_NAME: DetailsHeaderPlace = "name";
const AFTER_NAMESPACE: DetailsHeaderPlace = "namespace";

/**
 * What had the focus when the panel opened (#158): a table row, a link, a palette entry. Closing the panel gives the
 * focus back to it; a panel opened from inside the panel (an owner link) keeps the first one.
 */
let trigger: HTMLElement | null = null;

function returnFocus(): void {
  const target = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>("main [tabindex='0'], main button");
  trigger = null;
  target?.focus({ preventScroll: true });
}

/**
 * Panel that slides in from the right with the registered sections for the selected object. When a section placed as
 * a tab applies (an extension's), the panel gets a tab strip: "Overview" with the stacked sections, then those tabs.
 */
export function DetailsPanel({ clusterId, objectRef }: { clusterId: ClusterId; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const closeStore = useAppStore((s) => s.closeDetails);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Opening moves the focus to the panel's heading, so a screen reader reads the object and Tab continues inside.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".details")) trigger = active;
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const { obj, loading, error } = useDetailsObject(clusterId, objectRef);
  useDetailsSectionsVersion();
  const all = getDetailsSections(objectRef.kind);
  const sections = all.filter((s) => s.placement !== "tab");
  const tabs = all.filter((s) => s.placement === "tab");
  const [tab, setTab] = useState(OVERVIEW);

  const closeDetails = () => {
    closeStore();
    returnFocus();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open popup or dialog takes Escape for itself.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[aria-modal='true']")) {
        closeStore();
        returnFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeStore]);

  const state = (
    <>
      {error && <ErrorState error={error} />}
      {loading && !obj && !error && <div className="details__loading">{t("common:details.loading")}</div>}
    </>
  );
  const summary = sections.find((s) => s.id === "summary");
  const Summary = summary?.Component;
  const stacked = <>
    <DetailsSectionControls />
    <div className="details__body">
    {state}
    {Summary && <section className="details__summary" data-section={summary.id}><Summary clusterId={clusterId} objectRef={objectRef} obj={obj} /></section>}
    <div className="details__sections">{sections.filter((s) => s !== summary).map(({ id, Component }) => (
    <section key={id} className="details__section" data-section={id}>
      <DetailsSectionScope id={id}>
      <Component clusterId={clusterId} objectRef={objectRef} obj={obj} />
      </DetailsSectionScope>
    </section>
  ))}</div></div></>;
  // A tab that went away (its extension was disabled) leaves the panel on "Overview".
  const openTab = tabs.find((s) => s.id === tab);

  return (
    <aside className="details" aria-label={t("common:layout.details")}>
      <header className="details__header">
        <div className="details__heading">
          <div className="details__kind">{objectRef.kind.kind}</div>
          <div className="details__name-line">
            <h2 ref={headingRef} className="details__name" tabIndex={-1}>
              {objectRef.name}
            </h2>
            <HeaderTools place={AFTER_NAME} clusterId={clusterId} objectRef={objectRef} obj={obj} />
          </div>
          {objectRef.namespace && (
            <div className="details__namespace">
              <span>{t("common:details.inNamespace", { namespace: objectRef.namespace })}</span>
              <HeaderTools place={AFTER_NAMESPACE} clusterId={clusterId} objectRef={objectRef} obj={obj} />
            </div>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label={t("common:actions.closeDetails")} onClick={() => closeDetails()}>
          <Icon name="close" />
        </button>
      </header>
      <DetailsDisclosureProvider clusterId={clusterId} objectRef={objectRef}>
      {tabs.length === 0 ? stacked : (
        <Tabs
          className="details__tabs"
          label={t("extensions:host.detailsTabs")}
          tabs={[
            { id: OVERVIEW, label: t("extensions:host.overview") },
            ...tabs.map((s) => ({ id: s.id, label: s.labelKey ? t(s.labelKey) : (s.label ?? s.id) })),
          ]}
          selected={openTab ? tab : OVERVIEW}
          onSelect={setTab}
        >
          {openTab ? (
            <TabBody section={openTab} clusterId={clusterId} objectRef={objectRef} obj={obj} />
          ) : stacked}
        </Tabs>
      )}
      </DetailsDisclosureProvider>
    </aside>
  );
}

/** The icon buttons registered for `place` (copy, pin; `registerDetailsHeaderTool`), nothing when there are none. */
function HeaderTools({
  place,
  clusterId,
  objectRef,
  obj,
}: {
  place: DetailsHeaderPlace;
  clusterId: ClusterId;
  objectRef: ObjectRef;
  obj: KubeObject | null;
}) {
  const tools = getDetailsHeaderTools(place);
  if (tools.length === 0) return null;
  return (
    <span className="details__tools">
      {tools.map(({ id, Component }) => (
        <Component key={id} clusterId={clusterId} objectRef={objectRef} obj={obj} />
      ))}
    </span>
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
