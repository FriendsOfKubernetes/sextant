//! The tool registry of the MCP server: a tool is a name, a description, the JSON Schema of its arguments (from a
//! `#[derive(Deserialize, JsonSchema)]` struct) and an async function. Reading tools are added by `tools_read`,
//! changing ones by `tools_write` (task 04) — see `server::all_tools`.

use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sextant_core::{CoreError, ErrorCode};

use super::context::McpContext;
use super::guard::{CallSummary, ClusterTarget, Guard, OpenError, Refusal};

/// A tool answer is cut to this many bytes (with a note), so one call cannot flood the agent's context.
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// What a tool returns.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutput {
    /// Sent as compact JSON text; cut at the end when too long.
    Json(Value),
    /// Plain text (a value); cut at the end when too long.
    Text(String),
    /// Text whose end matters most (logs): cut at the start when too long.
    Tail(String),
}

/// Why a tool did not do its work.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolError {
    /// The rules or the user said no.
    Refused(Refusal),
    /// The cluster or the arguments: the `CoreError` text (exec-plugin secrets are already cut by the core).
    Failed(CoreError),
}

impl ToolError {
    /// The code the journal shows for this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            ToolError::Refused(_) => ErrorCode::Denied,
            ToolError::Failed(e) => e.code,
        }
    }

    /// The text the agent reads.
    pub fn message(&self) -> String {
        match self {
            ToolError::Refused(refusal) => refusal.to_string(),
            ToolError::Failed(e) => e.message.clone(),
        }
    }
}

impl From<Refusal> for ToolError {
    fn from(refusal: Refusal) -> Self {
        ToolError::Refused(refusal)
    }
}

impl From<CoreError> for ToolError {
    fn from(error: CoreError) -> Self {
        ToolError::Failed(error)
    }
}

impl From<OpenError> for ToolError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Refused(r) => ToolError::Refused(r),
            OpenError::Failed(e) => ToolError::Failed(e),
        }
    }
}

pub type ToolResult = Result<ToolOutput, ToolError>;

/// One call of a tool: the shared state and the guard that checks (and journals) it.
pub struct ToolCall {
    pub guard: Guard,
}

impl ToolCall {
    pub fn ctx(&self) -> &Arc<McpContext> {
        self.guard.context()
    }

    /// The cluster the agent named, connected; refused when access to it is Off.
    pub async fn open(&self, cluster: &str) -> Result<ClusterTarget, ToolError> {
        Ok(self.guard.open(cluster).await?)
    }

    /// The cluster the agent named, not connected; refused when access to it is Off.
    pub fn target(&self, cluster: &str, summary: &CallSummary) -> Result<ClusterTarget, ToolError> {
        Ok(self.guard.target(cluster, summary)?)
    }
}

type Run = Arc<dyn Fn(ToolCall, JsonObject) -> BoxFuture<'static, ToolResult> + Send + Sync>;

/// A registered tool.
#[derive(Clone)]
pub struct ToolDef {
    pub tool: Tool,
    run: Run,
}

impl ToolDef {
    pub fn run(&self, call: ToolCall, arguments: JsonObject) -> BoxFuture<'static, ToolResult> {
        (self.run)(call, arguments)
    }
}

/// Every tool the server offers.
#[derive(Clone, Default)]
pub struct ToolSet {
    defs: Vec<ToolDef>,
}

/// How a tool touches the cluster, for the client's hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    /// Only reads.
    Read,
    /// Changes something, nothing is removed.
    Change,
    /// May remove or replace something.
    Destructive,
}

impl ToolSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a tool whose arguments are `A`. A tool with the same name replaces the earlier one.
    pub fn add<A, F, Fut>(
        &mut self,
        name: &'static str,
        description: &'static str,
        kind: ToolKind,
        run: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + JsonSchema + std::any::Any + Send + 'static,
        F: Fn(ToolCall, A) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ToolResult> + Send + 'static,
    {
        let annotations = ToolAnnotations::new()
            .read_only(kind == ToolKind::Read)
            .destructive(kind == ToolKind::Destructive)
            .open_world(false);
        let tool = Tool::new(name, description, schema_of::<A>()).with_annotations(annotations);
        let run = Arc::new(run);
        let run: Run = Arc::new(move |call: ToolCall, arguments: JsonObject| {
            let run = Arc::clone(&run);
            Box::pin(async move {
                let args: A = serde_json::from_value(Value::Object(arguments)).map_err(|e| {
                    ToolError::Failed(CoreError::new(
                        ErrorCode::Invalid,
                        format!("invalid arguments: {e}"),
                    ))
                })?;
                run(call, args).await
            })
        });
        self.defs.retain(|d| d.tool.name != name);
        self.defs.push(ToolDef { tool, run });
        self
    }

    pub fn tools(&self) -> Vec<Tool> {
        self.defs.iter().map(|d| d.tool.clone()).collect()
    }

    pub fn find(&self, name: &str) -> Option<&ToolDef> {
        self.defs.iter().find(|d| d.tool.name == name)
    }

    pub fn names(&self) -> Vec<String> {
        self.defs.iter().map(|d| d.tool.name.to_string()).collect()
    }
}

/// The JSON Schema of a tool's arguments (an object schema, as MCP wants it).
fn schema_of<A: JsonSchema + std::any::Any>() -> Arc<JsonObject> {
    rmcp::handler::server::common::schema_for_type::<A>()
}

/// The tool result the agent gets: text content, `isError` for a failure.
pub fn to_call_result(result: &ToolResult) -> CallToolResult {
    match result {
        Ok(output) => CallToolResult::success(vec![ContentBlock::text(render(output))]),
        Err(error) => CallToolResult::error(vec![ContentBlock::text(error.message())]),
    }
}

fn render(output: &ToolOutput) -> String {
    match output {
        ToolOutput::Json(value) => cut_end(value.to_string()),
        ToolOutput::Text(text) => cut_end(text.clone()),
        ToolOutput::Tail(text) => cut_start(text),
    }
}

fn cut_note() -> String {
    format!("[output cut at {} KB]", MAX_OUTPUT_BYTES / 1024)
}

/// The first [`MAX_OUTPUT_BYTES`] of `text` and a note, when it is longer.
pub fn cut_end(mut text: String) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push('\n');
    text.push_str(&cut_note());
    text
}

/// A note and the last [`MAX_OUTPUT_BYTES`] of `text`, when it is longer.
pub fn cut_start(text: &str) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text.to_owned();
    }
    let mut start = text.len() - MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("{}\n{}", cut_note(), &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_output_is_cut_with_a_note() {
        let long = "é".repeat(MAX_OUTPUT_BYTES);
        let cut = cut_end(long.clone());
        assert!(cut.len() <= MAX_OUTPUT_BYTES + 40);
        assert!(cut.ends_with("[output cut at 256 KB]"));
        assert!(cut.starts_with("éé"));

        let tail = cut_start(&format!("first{long}last"));
        assert!(tail.starts_with("[output cut at 256 KB]"));
        assert!(tail.ends_with("last"));
        assert!(tail.len() <= MAX_OUTPUT_BYTES + 40);

        assert_eq!(cut_end("short".into()), "short");
        assert_eq!(cut_start("short"), "short");
    }

    #[test]
    fn failures_are_tool_errors_with_their_text() {
        let failed: ToolResult = Err(ToolError::Failed(CoreError::new(
            ErrorCode::NotFound,
            "pods \"x\" not found",
        )));
        let result = to_call_result(&failed);
        assert_eq!(result.is_error, Some(true));
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["content"][0]["text"], "pods \"x\" not found");
        assert_eq!(
            ToolError::Refused(Refusal::ClusterOff {
                cluster: "c".into()
            })
            .code(),
            ErrorCode::Denied
        );
    }
}
