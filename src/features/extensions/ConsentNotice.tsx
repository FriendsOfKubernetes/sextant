// A notice across the window when an extension that runs from a folder now asks for more than you allowed: it is
// paused, and "Review permissions" opens the window of consent. Mounted once by the window shell (`AppShell`), so
// folding the rail or narrowing the window keeps the notice dismissed and the window open; drawn into <body>, so it
// shows whatever the main area holds (like the settings file banner).
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ExtensionInfo } from "../../api";
import { Button } from "../../components";
import { useExtensions } from "../../extensions";
import { ReviewDialog } from "./ReviewDialog";
import "./extensions.css";

export function ConsentNotice() {
  const { t } = useTranslation();
  const { extensions } = useExtensions();
  // Ids dismissed with the cross: they come back only if the extension is paused again after being fine.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<ExtensionInfo | null>(null);
  const paused = extensions.filter((e) => e.needsConsent && !dismissed.has(e.id));
  const reviewingNow = reviewing ? extensions.find((e) => e.id === reviewing.id) : undefined;
  if (paused.length === 0 && !reviewingNow) return null;
  return createPortal(
    <>
      {paused.length > 0 && (
        <div className="ext-consent-notice" role="alert">
          <span className="ext-consent-notice__text">
            {t("extensions:notice.text", { count: paused.length, names: paused.map((e) => e.name).join(", ") })}
          </span>
          <Button variant="primary" onClick={() => setReviewing(paused[0] ?? null)}>
            {t("extensions:notice.review")}
          </Button>
          <Button
            iconOnly
            icon="close"
            label={t("extensions:notice.dismiss")}
            onClick={() => setDismissed(new Set([...dismissed, ...paused.map((e) => e.id)]))}
          />
        </div>
      )}
      {reviewingNow && <ReviewDialog info={reviewingNow} onClose={() => setReviewing(null)} />}
    </>,
    document.body,
  );
}
