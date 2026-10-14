//! Confirmations of agent calls: the shared mechanism of [`crate::access_guard::confirm`] (agents and extensions use
//! one pending map and one answer command, `mcp_confirm_answer`).

pub use crate::access_guard::confirm::*;
