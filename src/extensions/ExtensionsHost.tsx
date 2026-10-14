// Mounted once by the window shell (`AppShell`): keeps the registries in step with the installed extensions
// (`syncExtensions`) and shows the notices extensions send (`ui.notify`).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components";
import { syncExtensions } from "./contributions";
import { dismissNotice, useNotices } from "./notices";
import { useExtensions } from "./store";
import "./extensions.css";

export function ExtensionsHost() {
  const { extensions } = useExtensions();
  useEffect(() => syncExtensions(extensions), [extensions]);
  // Leaving (tests, a new window shell) takes every contribution along.
  useEffect(() => () => syncExtensions([]), []);
  return <ExtensionNotices />;
}

function ExtensionNotices() {
  const { t } = useTranslation();
  const notices = useNotices();
  return (
    <div className="ext-notices" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className="ext-notice">
          <span className="ext-notice__text">
            {t("extensions:host.notice", { extension: notice.extension, text: notice.text })}
          </span>
          <Button
            iconOnly
            icon="close"
            size="compact"
            label={t("extensions:host.dismiss")}
            onClick={() => dismissNotice(notice.id)}
          />
        </div>
      ))}
    </div>
  );
}
