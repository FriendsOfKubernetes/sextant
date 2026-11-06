// The consent screen's block about tools for AI agents (ADR-0159): each tool by its title and description. Agreeing
// grants exactly these; an update that adds or changes one asks again. Agents get them only once the user turns the
// extension on for agents.
import { useTranslation } from "react-i18next";
import type { AgentToolContribution } from "../../api";

export function AgentToolsConsent({ tools }: { tools: readonly AgentToolContribution[] }) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:agentTools.heading")}</h3>
      <p>{t("extensions:agentTools.list")}</p>
      <ul className="ext-backend__list">
        {tools.map((tool) => (
          <li key={tool.id}>
            {tool.title}
            <br />
            <span className="settings__hint">{tool.description}</span>
          </li>
        ))}
      </ul>
      <p className="settings__hint">{t("extensions:agentTools.scope")}</p>
    </>
  );
}
