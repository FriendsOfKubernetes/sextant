// A notice across the window when an extension now asks for more than you allowed: it is paused. For one that runs
// from a folder "Review permissions" opens the window of consent; one installed from a file or a link can only be
// reviewed by installing it again, and the notice says from where. Mounted once by the window shell (`AppShell`), so
// folding the rail or narrowing the window keeps the notice dismissed and the window open; drawn into <body>, so it
// shows whatever the main area holds (like the settings file banner).
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ExtensionInfo } from "../../api";
import { Button } from "../../components";
import { useExtensions } from "../../extensions";
import { reinstallText } from "./install";
import { ReviewDialog } from "./ReviewDialog";
import "./extensions.css";
import { formatList } from "../../i18n";

export function ConsentNotice() {
  const { t } = useTranslation();
  const { extensions } = useExtensions();
  // Ids dismissed with the cross: they come back only if the extension is paused again after being fine.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<ExtensionInfo | null>(null);
  const paused = extensions.filter((e) => e.needsConsent && !dismissed.has(e.id));
  const reviewable = paused.find((e) => e.source.type === "folder");
  const reinstall = paused.flatMap((e) => {
    const hint = reinstallText(e.source, t);
    return hint === null ? [] : [{ id: e.id, text: t("extensions:notice.reinstall", { name: e.name, hint }) }];
  });
  const reviewingNow = reviewing ? extensions.find((e) => e.id === reviewing.id) : undefined;
  if (paused.length === 0 && !reviewingNow) return null;
  return createPortal(
    <>
      {paused.length > 0 && (
        <div className="ext-consent-notice" role="alert">
          <span className="ext-consent-notice__text">
            {t("extensions:notice.text", { count: paused.length, names: formatList(paused.map((e) => e.name)) })}
            {reinstall.map((line) => (
              <span key={line.id} className="ext-consent-notice__line">
                {line.text}
              </span>
            ))}
          </span>
          {reviewable && (
            <Button variant="primary" onClick={() => setReviewing(reviewable)}>
              {t("extensions:notice.review")}
            </Button>
          )}
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
