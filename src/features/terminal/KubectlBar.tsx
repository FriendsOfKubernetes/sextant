// The kubectl offer of a cluster's terminal (ADR-0132): when the terminal would run no kubectl, or one more than a
// minor version from the server, a bar above it offers the kubectl of the cluster's version, installed into Sextant's
// own folder for its terminals only. The backend picks the version; the window names only the cluster.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, updateSettings, type KubectlOffer } from "../../api";
import { Button } from "../../components";
import { toolsChanged } from "./toolsChanged";

/** Clusters whose offer was put off with "Not now" in this run of the window. */
const notNow = new Set<string>();

/** Forgets every "Not now" (tests). */
export function resetKubectlOffers(): void {
  notNow.clear();
}

type Step = { kind: "offer" } | { kind: "installing" } | { kind: "installed"; version: string } | { kind: "failed"; message: string };

export function KubectlBar({ clusterId }: { clusterId: string }) {
  const { t } = useTranslation();
  const [offer, setOffer] = useState<KubectlOffer | null>(null);
  const [step, setStep] = useState<Step>({ kind: "offer" });
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (notNow.has(clusterId)) return;
    let live = true;
    api.tools.kubectlOffer(clusterId).then(
      (answer) => live && setOffer(answer),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [clusterId]);

  if (!offer || hidden) return null;
  const server = offer.server;
  const install = async () => {
    setStep({ kind: "installing" });
    try {
      const installed = await api.tools.install("kubectl", clusterId);
      setStep({ kind: "installed", version: installed.version });
      toolsChanged();
    } catch (err) {
      setStep({ kind: "failed", message: toApiError(err).message });
    }
  };
  const text =
    step.kind === "installing"
      ? t("tools:offer.installing")
      : step.kind === "installed"
        ? t("tools:offer.installed", { version: step.version })
        : step.kind === "failed"
          ? t("tools:offer.failed", { message: step.message })
          : offer.need.type === "missing"
            ? t("tools:offer.missing", { server })
            : t("tools:offer.outOfSkew", { server, found: offer.need.found });
  return (
    <div className="terminal__offer" role="status">
      <span>{text}</span>
      {(step.kind === "offer" || step.kind === "failed") && (
        <span className="terminal__offer-actions">
          <Button size="compact" variant="primary" onClick={() => void install()}>
            {t("tools:offer.install", { server })}
          </Button>
          <Button
            size="compact"
            onClick={() => {
              notNow.add(clusterId);
              setHidden(true);
            }}
          >
            {t("tools:offer.notNow")}
          </Button>
          <Button
            size="compact"
            onClick={() => {
              setHidden(true);
              void updateSettings((s) => ({ ...s, terminalTools: { ...s.terminalTools, offerKubectl: false } }));
            }}
          >
            {t("tools:offer.neverAsk")}
          </Button>
        </span>
      )}
      {step.kind === "installed" && (
        <Button size="compact" onClick={() => setHidden(true)}>
          {t("common:actions.close")}
        </Button>
      )}
    </div>
  );
}
