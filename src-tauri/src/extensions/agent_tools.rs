//! The tools extensions give AI agents (`contributes.agentTools`, ADR-0159), as Sextant's MCP server lists and runs
//! them: only of extensions that are active, whose tools the user agreed to, and that the user lets agents have
//! (`AppSettings.mcp.extensionTools`). A call runs the extension's backend for the agent
//! ([`ExtensionApi::agent_tool_call`]): everything it does is decided for the extension and the agent both.

use std::sync::Arc;

use futures::future::BoxFuture;
use rmcp::model::{JsonObject, Tool, ToolAnnotations};
use serde_json::Value;
use sextant_core::extensions::agent_tools::mcp_tool_name;

use super::ExtensionHost;
use super::api::ExtensionApi;
use crate::mcp::context::ExtensionToolSource;
use crate::mcp::tools::{ToolError, ToolOutput, ToolResult};

/// The extensions' tools for the MCP server.
pub struct ExtensionAgentTools {
    pub host: ExtensionHost,
    pub api: Arc<ExtensionApi>,
}

/// One offered tool: its MCP name and what runs it.
struct Offered {
    tool: Tool,
    extension: String,
    id: String,
}

impl ExtensionAgentTools {
    /// The tools offered now (reads the extensions off the async runtime: a development folder is walked).
    fn offered(&self) -> BoxFuture<'static, Vec<Offered>> {
        let (host, api) = (self.host.clone(), Arc::clone(&self.api));
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || offered_now(&host, &api))
                .await
                .unwrap_or_default()
        })
    }
}

fn offered_now(host: &ExtensionHost, api: &ExtensionApi) -> Vec<Offered> {
    let chosen = api.settings.get().mcp.extension_tools;
    let mut out = Vec::new();
    for id in chosen {
        let Some(entry) = host.active(&id) else {
            continue;
        };
        let name = host.info(&id).map_or_else(|| id.clone(), |i| i.name);
        for tool in entry.granted_agent_tools.iter().flatten() {
            let Some(schema) = tool.input_schema.as_object().cloned() else {
                continue;
            };
            let annotations = ToolAnnotations::new()
                .read_only(tool.read_only)
                .destructive(!tool.read_only)
                .open_world(false);
            let description = format!(
                "{} (A tool of the Sextant extension {name}.)",
                tool.description
            );
            out.push(Offered {
                tool: Tool::new(mcp_tool_name(&id, &tool.id), description, Arc::new(schema))
                    .with_annotations(annotations),
                extension: id.clone(),
                id: tool.id.clone(),
            });
        }
    }
    out
}

impl ExtensionToolSource for ExtensionAgentTools {
    fn tools(&self) -> BoxFuture<'static, Vec<Tool>> {
        let offered = self.offered();
        Box::pin(async move { offered.await.into_iter().map(|o| o.tool).collect() })
    }

    fn call(
        &self,
        client: String,
        name: String,
        arguments: JsonObject,
    ) -> BoxFuture<'static, Option<ToolResult>> {
        let offered = self.offered();
        let (host, api) = (self.host.clone(), Arc::clone(&self.api));
        Box::pin(async move {
            let found = offered.await.into_iter().find(|o| o.tool.name == name)?;
            let result = api
                .agent_tool_call(
                    &host,
                    &found.extension,
                    &found.id,
                    Value::Object(arguments),
                    &client,
                )
                .await;
            Some(match result {
                Ok(value) => Ok(ToolOutput::Json(value)),
                Err(err) => Err(ToolError::Failed(err.without_plugin_output())),
            })
        })
    }
}
