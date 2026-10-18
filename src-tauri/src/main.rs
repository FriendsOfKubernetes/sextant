// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    // Before any thread starts: fewer malloc arenas keep less freed memory (#170).
    sextant_lib::malloc::limit_arenas();
    // `sextant mcp`: the stdio proxy to the MCP server of the running application, without a window or Tauri.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        return sextant_lib::mcp_proxy::run();
    }
    sextant_lib::run();
    ExitCode::SUCCESS
}
