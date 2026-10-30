//! Exec auth plugins in Sextant's own connections run as client-go runs them in a process without a terminal (#288).
//!
//! client-go (`plugin/pkg/client/auth/exec/exec.go`, `isInteractive`) runs a plugin with `interactiveMode:
//! IfAvailable` (the default) without stdin when standard input is not a terminal, and refuses `Always` there
//! ("standard input is not a terminal"). kube-client runs every plugin but `Never` interactively, with stdin and
//! stderr inherited: in a desktop app that shows the plugin's prompt nowhere, loses its stderr for the error message
//! (`CoreError.pluginOutput`), and on Windows gives every run a console window of its own. So Sextant's connections
//! turn `IfAvailable` (and no mode) into `Never` and refuse `Always` with what to do, and on Windows start plugins
//! without a console window. Sextant's terminals are not affected: their kubectl reads the kubeconfig file itself.

use kube::config::{ExecInteractiveMode, Kubeconfig};

use crate::error::{CoreError, CoreResult, ErrorCode};

/// Every exec plugin of `kubeconfig` set to run without a terminal (`interactiveMode: Never`); a plugin that asks for
/// one (`Always`) is an `authPlugin` error naming its command (never its arguments or env).
pub fn without_terminal(kubeconfig: &mut Kubeconfig) -> CoreResult<()> {
    for named in &mut kubeconfig.auth_infos {
        let Some(exec) = named.auth_info.as_mut().and_then(|auth| auth.exec.as_mut()) else {
            continue;
        };
        if exec.interactive_mode == Some(ExecInteractiveMode::Always) {
            return Err(needs_terminal(exec.command.as_deref()));
        }
        exec.interactive_mode = Some(ExecInteractiveMode::Never);
    }
    Ok(())
}

fn needs_terminal(plugin: Option<&str>) -> CoreError {
    let name = plugin.map_or_else(
        || "the auth plugin".to_owned(),
        |p| format!("the auth plugin '{p}'"),
    );
    CoreError::new(
        ErrorCode::AuthPlugin,
        format!(
            "{name} asks for a terminal (interactiveMode: Always), which Sextant's connections do not have, as \
             kubectl without one refuses it: set interactiveMode to IfAvailable in the kubeconfig (most plugins \
             sign in without a terminal), or use this context from a terminal"
        ),
    )
}

/// On Windows, starts every exec plugin without a console window of its own (kube-client's
/// `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW`), unless the user set the variable: after [`without_terminal`] no plugin
/// needs one. Call first thing in `main`, before any thread starts. Returns whether it set it; a no-op (false)
/// elsewhere than Windows.
pub fn hide_plugin_consoles() -> bool {
    #[cfg(windows)]
    {
        const VAR: &str = "KUBE_RS_UNSTABLE_CREATE_NO_WINDOW";
        if std::env::var_os(VAR).is_some() {
            return false;
        }
        // SAFETY: called first thing in `main`, before any other thread exists to read the environment.
        unsafe { std::env::set_var(VAR, "1") };
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kubeconfig(mode: Option<&str>) -> Kubeconfig {
        let mode = mode.map_or_else(String::new, |m| format!("\n      interactiveMode: {m}"));
        Kubeconfig::from_yaml(&format!(
            "apiVersion: v1
kind: Config
current-context: c
contexts: [{{name: c, context: {{cluster: k, user: u}}}}]
clusters: [{{name: k, cluster: {{server: 'https://127.0.0.1:6443'}}}}]
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: aws
      args: [eks, get-token, --cluster-name, SECRET-ARG]{mode}
- name: token
  user: {{token: abc}}
"
        ))
        .unwrap()
    }

    fn mode_of(kubeconfig: &Kubeconfig) -> Option<ExecInteractiveMode> {
        kubeconfig.auth_infos[0]
            .auth_info
            .as_ref()?
            .exec
            .as_ref()?
            .interactive_mode
            .clone()
    }

    #[test]
    fn plugins_that_may_go_without_a_terminal_run_without_one() {
        for mode in [None, Some("IfAvailable"), Some("Never")] {
            let mut config = kubeconfig(mode);
            without_terminal(&mut config).unwrap();
            assert_eq!(
                mode_of(&config),
                Some(ExecInteractiveMode::Never),
                "{mode:?}"
            );
            // A user without a plugin is left as it is.
            assert!(
                config.auth_infos[1]
                    .auth_info
                    .as_ref()
                    .unwrap()
                    .exec
                    .is_none()
            );
        }
    }

    #[test]
    fn a_plugin_that_asks_for_a_terminal_is_refused_with_what_to_do() {
        let err = without_terminal(&mut kubeconfig(Some("Always"))).unwrap_err();
        assert_eq!(err.code, ErrorCode::AuthPlugin);
        assert!(
            err.message.contains("the auth plugin 'aws'"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("interactiveMode to IfAvailable"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("SECRET-ARG"), "{}", err.message);
    }

    #[test]
    fn plugin_consoles_are_left_alone_elsewhere_than_windows() {
        if !cfg!(windows) {
            assert!(!hide_plugin_consoles());
        }
    }
}
