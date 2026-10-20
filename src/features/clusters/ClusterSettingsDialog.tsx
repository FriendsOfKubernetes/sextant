// The cluster settings dialog: registered sections for one cluster, grouped into tabs (#230; settingsRegistry.ts).
// The tab picked last is remembered for the window's lifetime; `openClusterSettings(id, sectionId)` opens the tab of
// that section and brings the section into view.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { Button, Dialog, Tabs } from "../../components";
import { displayNameOf } from "./clusterSettings";
import { openClusterSettings, selectClusterSettingsTab, useClustersStore } from "./clustersStore";
import { getClusterSettingsTabs } from "./settingsRegistry";

const ID_PREFIX = "cluster-settings";

/** The element id of a section, for deep links. */
export function clusterSettingsSectionId(sectionId: string): string {
  return `${ID_PREFIX}-section-${sectionId}`;
}

export function ClusterSettingsDialog() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const clusterId = useClustersStore((s) => s.settingsFor);
  const cluster = useClustersStore((s) => s.clusters.find((c) => c.id === clusterId));
  const remembered = useClustersStore((s) => s.settingsTab);
  const focus = useClustersStore((s) => s.settingsFocus);
  const close = () => openClusterSettings(null);
  const tabs = getClusterSettingsTabs();
  const selected = tabs.find((tab) => tab.id === remembered) ?? tabs[0];
  const open = Boolean(clusterId && cluster);

  // A deep link to a section (not the icon field, which focuses itself): scroll to it and put the focus on it, once
  // the dialog and its tab are drawn.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !focus || focus === "icon") {
      shown.current = null;
      return;
    }
    if (shown.current === focus) return;
    shown.current = focus;
    const el = document.getElementById(clusterSettingsSectionId(focus));
    el?.scrollIntoView?.({ block: "nearest" });
    el?.focus({ preventScroll: true });
  }, [open, focus, selected?.id]);

  if (!clusterId || !cluster) return null;

  const several = (selected?.sections.length ?? 0) > 1;
  return (
    <Dialog
      open
      title={t("clusters:settings.title", { name: displayNameOf(cluster, settings) })}
      onClose={close}
      footer={<Button onClick={close}>{t("common:actions.close")}</Button>}
    >
      <div className="cluster-settings">
        {selected && (
          <Tabs
            label={t("clustersettings:tabsLabel")}
            tabs={tabs.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }))}
            selected={selected.id}
            onSelect={selectClusterSettingsTab}
            idPrefix={ID_PREFIX}
            className="cluster-settings__tabs"
          >
            {selected.sections.map(({ id, titleKey, Component }) => (
              <section
                key={id}
                id={clusterSettingsSectionId(id)}
                tabIndex={-1}
                className="cluster-settings__section"
                aria-label={titleKey ? t(titleKey) : undefined}
              >
                {/* One section: the tab already names it. */}
                {several && titleKey && <h3 className="clusters-subtitle">{t(titleKey)}</h3>}
                <Component clusterId={clusterId} cluster={cluster} />
              </section>
            ))}
          </Tabs>
        )}
      </div>
    </Dialog>
  );
}
