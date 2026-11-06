// The offers above the sidebar's sections (`sidebarTop`): one line per extension of Sextant's own whose tool the active
// cluster runs (offers.ts). "Install" opens the catalog's install in Settings → Extensions (the package checked, then
// the consent window); "Not now" hides it for this run; "Don't offer again" keeps it hidden.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useSettings } from "../../api";
import { useAppStore } from "../../app/store";
import { Button } from "../../components";
import { useExtensions } from "../../extensions";
import { useClusterKinds } from "../../resources";
import { requestCatalogInstall } from "../extensions/installRequest";
import { offerOf, offersFor, type ExtensionOffer } from "./offers";
import "./offers.css";

/** Offers answered "Not now" in this run. */
const useNotNow = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

/** Forgets the "Not now" answers (tests). */
export function resetNotNow(): void {
  useNotNow.setState({ ids: new Set() });
}

export function ExtensionOffers() {
  const clusterId = useAppStore((s) => s.activeClusterId);
  const { kinds } = useClusterKinds(clusterId);
  const { extensions, loaded } = useExtensions();
  const { settings } = useSettings();
  const notNow = useNotNow((s) => s.ids);
  const offers = useMemo(() => {
    if (!kinds || !loaded || !settings) return [];
    const installed = new Set(extensions.map((e) => e.id));
    return offersFor(
      kinds.map((k) => k.kindRef),
      installed,
      settings.extensionCatalog.declinedOffers,
      notNow,
    );
  }, [kinds, loaded, extensions, settings, notNow]);
  if (offers.length === 0) return null;
  return (
    <div className="ext-offers">
      {offers.map((offer) => (
        <OfferCard key={offer.id} offer={offer} />
      ))}
    </div>
  );
}

function OfferCard({ offer }: { offer: ExtensionOffer }) {
  const { t } = useTranslation();
  const { update } = useSettings();
  const decline = () =>
    void update((s) => ({
      ...s,
      extensionCatalog: { ...s.extensionCatalog, declinedOffers: [...s.extensionCatalog.declinedOffers.filter((id) => id !== offer.id), offer.id] },
    }));
  return (
    <section className="ext-offers__card" aria-label={t("extensionoffers:label", { tool: offer.tool })}>
      <p className="ext-offers__text">{t("extensionoffers:text", { tool: offer.tool })}</p>
      <div className="ext-offers__buttons">
        <Button size="compact" variant="primary" icon="download" onClick={() => requestCatalogInstall(offer.id)}>
          {t("extensionoffers:install")}
        </Button>
        <Button size="compact" onClick={() => useNotNow.setState((s) => ({ ids: new Set([...s.ids, offer.id]) }))}>
          {t("extensionoffers:notNow")}
        </Button>
        <Button size="compact" onClick={decline}>
          {t("extensionoffers:never")}
        </Button>
      </div>
    </section>
  );
}

/** After Sextant installed a tool (Flux, Argo CD): its extension, or the button that installs it from the catalog. */
export function ToolExtensionOffer({ id }: { id: string }) {
  const { t } = useTranslation();
  const { extensions, loaded } = useExtensions();
  const offer = offerOf(id);
  if (!offer || !loaded) return null;
  if (extensions.some((e) => e.id === id)) {
    return <p className="ext-offers__text">{t("extensionoffers:installed", { tool: offer.tool })}</p>;
  }
  return (
    <div className="ext-offers__card">
      <p className="ext-offers__text">{t("extensionoffers:installed", { tool: offer.tool })}</p>
      <div className="ext-offers__buttons">
        <Button variant="primary" icon="download" onClick={() => requestCatalogInstall(id)}>
          {t("extensionoffers:installExtension", { tool: offer.tool })}
        </Button>
      </div>
    </div>
  );
}
