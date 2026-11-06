# ADR-0159: Extensions give AI agents tools, within the agent's own access

## Context

Built-in features give agents tools: `gitops_action` syncs Argo CD Applications and reconciles Flux objects.
Extension problems reach agents only on the user's choice (ADR-0146), but an extension could add no tool. Moving
such a feature out would take the tool away from agents (#353).

## Decision

- **`contributes.agentTools` (`sextantApi` 4, needs a `backend`).** Each tool is `{id, title, description,
  inputSchema, readOnly?}`, at most 10.
  - The MCP name is `ext_<extension id with dots as _>__<tool id>` (`mcp_tool_name`). Ids have no `_`, so the name is
    unique, and it must fit 64 characters.
  - `inputSchema` is a JSON Schema subset of an object. The keywords are `type`, `description`, `properties`,
    `required`, `additionalProperties` (a boolean), `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`,
    `minItems` and `maxItems`. It is at most 4 deep and 8 KiB, every `required` name is a property, and `items` and
    the object keywords only go where their type is (`check_agent_tools` = `checkAgentTools`).
  - The title is translatable. The description is for agents and stays as written.
- **Consent and choice.**
  - The user agrees to the tools word for word (`grantedAgentTools`), and an update that changes one asks again.
  - The user lets agents have an extension's tools in Settings → AI agents (MCP), via
    `AppSettings.mcp.extensionTools`. It is frontend-written and empty by default, like `extensionProblems`.
- **Listing and running.**
  - Sextant's MCP server lists the offered tools with its own on every `tools/list` (`ExtensionToolSource`, set when
    the extensions start). The description names the extension.
  - A call runs the backend's `handle("agentTool:<id>", arguments)` (`ExtensionApi::agent_tool_call`). The
    extension's journal records `agentTool`, and the MCP activity log records the tool call with its outcome.
- **The agent never gets more through an extension.** Every call the backend makes while it answers an agent
  (`AgentLimit`) is decided twice:
  - against the extension's grant;
  - against the agent's own access rules in that cluster (`clusters[id].agentAccess`). A command in a pod needs the
    agent's Exec, and a listing is narrowed to the namespaces both allow.

  The user is asked when either asks. The dialog and the journal name "AI agent <client> through extension <name>".

## Consequences

- An extension can bring agents the tools of the feature it replaces, such as sync and reconcile.
- An agent with read-only access gets read-only results through any extension tool. A user who never ticks the
  extension gives agents nothing of it.
