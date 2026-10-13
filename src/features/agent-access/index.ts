// Agent access (MCP server): the "AI agent access" section of the cluster settings, where the user picks what AI
// agents may do in the cluster. The rules are enforced by the core; this feature only edits them.
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { AgentAccessSection } from "./AgentAccessSection";

registerClusterSettingsSection({
  id: "agentAccess",
  order: 30,
  titleKey: "access:title",
  Component: AgentAccessSection,
});

export { makeAccess, newRule, parseKindInput, parseNamespaceInput } from "./rules";
