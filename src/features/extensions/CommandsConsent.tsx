// The consent screen's block about commands (ADR-0147): each program the extension may run, word for word, the pods
// it runs in, and whether it changes something (then Sextant asks every time). Agreeing grants exactly these commands;
// an update that adds or changes one asks again.
import { useTranslation } from "react-i18next";
import type { CommandContribution } from "../../api";

export function CommandsConsent({ commands }: { commands: readonly CommandContribution[] }) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:commands.heading")}</h3>
      <p>{t("extensions:commands.list")}</p>
      <ul className="ext-backend__list">
        {commands.map((command) => (
          <li key={command.id}>
            {command.title}
            <br />
            <code>{command.argv.join(" ")}</code>
            <br />
            <span className="settings__hint">
              {t(command.changes ? "extensions:commands.changes" : "extensions:commands.reads", {
                selector: command.target.labelSelector,
                container: command.target.container,
              })}
            </span>
          </li>
        ))}
      </ul>
      <p className="settings__hint">{t("extensions:commands.scope")}</p>
    </>
  );
}
