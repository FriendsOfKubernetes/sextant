// The consent screen's block about commands (ADR-0147): each program the extension may run, word for word, the pods
// it runs in, and whether it changes something (then Sextant asks every time). Agreeing grants exactly these commands;
// an update that adds or changes one asks again. Under each command, what each of its parameters may be (#339).
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CommandContribution } from "../../api";
import { formatList, formatNumber } from "../../i18n/format";

type CommandParam = CommandContribution["params"][number];

/** What a parameter may be, in one sentence: one of its values, a whole number within its range, or a name. */
function paramText(t: TFunction, param: CommandParam): string {
  const name = param.name;
  if (param.type === "enum") return t("extensions:commands.params.enum", { name, values: formatList(param.values ?? []) });
  if (param.type === "name") return t("extensions:commands.params.name", { name });
  const min = param.min === undefined ? undefined : formatNumber(param.min);
  const max = param.max === undefined ? undefined : formatNumber(param.max);
  if (min !== undefined && max !== undefined) return t("extensions:commands.params.int", { name, min, max });
  if (min !== undefined) return t("extensions:commands.params.intFrom", { name, min });
  if (max !== undefined) return t("extensions:commands.params.intTo", { name, max });
  return t("extensions:commands.params.intAny", { name });
}

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
            {command.params.length > 0 && (
              <ul className="ext-backend__list">
                {command.params.map((param) => (
                  <li key={param.name}>{paramText(t, param)}</li>
                ))}
              </ul>
            )}
            {command.params.length === 0 && <br />}
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
