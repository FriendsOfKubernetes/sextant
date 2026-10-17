# Sextant

[![CI](https://github.com/FriendsOfKubernetes/sextant/actions/workflows/ci.yml/badge.svg)](https://github.com/FriendsOfKubernetes/sextant/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/FriendsOfKubernetes/sextant?sort=semver)](https://github.com/FriendsOfKubernetes/sextant/releases/latest)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

Sextant is a desktop application for managing Kubernetes clusters — an alternative to Lens, written in Rust on
[Tauri 2](https://tauri.app). It reads your kubeconfig, shows the resources of every cluster in live tables and
lets you inspect, edit and operate them in one window. Linux, macOS and Windows.

![Sextant: connecting to a cluster, the pods, their details, logs and a shell](docs/demo.gif)

## Features

- **Your kubeconfig** — every context is a cluster; several can be connected at once.
- **Cloud clusters** — find your Amazon EKS, Google GKE and Azure AKS clusters through the `aws`, `gcloud` and `az`
  you already use, and add them in a few clicks.
- **Every resource** in live tables, with details, a YAML editor, scale, restart, cordon, drain and CronJob actions.
- **Logs, shells and port forwarding** — container logs with search, a shell in any container, a shell on a node
  (a temporary privileged pod, removed when you close it), a local terminal already pointed at the cluster.
- **Metrics** from metrics-server and Prometheus; **Helm** releases and charts; **Flux** and **Argo CD** (sync, diff).
- **MCP server for AI agents** — connect Claude Code, Claude Desktop or Cursor to your clusters, with permissions you
  set per cluster, confirmations in the window and an activity log.
- No account, no server, no telemetry.

An AI agent asks to scale a deployment; Sextant asks you first and records the call:

![An AI agent asks through the MCP server, the user allows it in the window, the call is in the activity log](docs/demo-mcp.gif)

## Install

Download the installer (`.deb`, `.AppImage`, `.dmg` or `.msi`) from the
[latest release](https://github.com/FriendsOfKubernetes/sextant/releases/latest). The installers are not code-signed,
so macOS and Windows warn on first start — see [Installation](https://github.com/FriendsOfKubernetes/sextant/wiki/Installation).

## Documentation

The [wiki](https://github.com/FriendsOfKubernetes/sextant/wiki) describes everything:

- [Installation](https://github.com/FriendsOfKubernetes/sextant/wiki/Installation) — installers, unsigned builds, updates
- [Getting started](https://github.com/FriendsOfKubernetes/sextant/wiki/Getting-started) — kubeconfig, cloud clusters (EKS, GKE, AKS), connecting, the window
- [Using Sextant](https://github.com/FriendsOfKubernetes/sextant/wiki/Using-Sextant) — tables, YAML, logs, shells (containers and nodes), port forwarding, Helm, Flux, Argo CD
- [Gateway API](https://github.com/FriendsOfKubernetes/sextant/wiki/Gateway-API) — Gateways and routes with explained problems, topology, the request check and the hostname map
- [Installing Flux and Argo CD](https://github.com/FriendsOfKubernetes/sextant/wiki/Installing-Flux-and-Argo-CD) — from the app: sources and checks, rights, preview, removing them by hand
- [MCP server](https://github.com/FriendsOfKubernetes/sextant/wiki/MCP-server) — AI agents: setup, permissions, confirmations, security
- [Extensions](https://github.com/FriendsOfKubernetes/sextant/wiki/Extensions) and [Writing extensions](https://github.com/FriendsOfKubernetes/sextant/wiki/Writing-extensions) — your own pages, panels, actions and columns in isolated frames, with permissions you agree to; the SDK in `sdk/`
- [Settings](https://github.com/FriendsOfKubernetes/sextant/wiki/Settings) and [Troubleshooting](https://github.com/FriendsOfKubernetes/sextant/wiki/Troubleshooting)
- [Building from source](https://github.com/FriendsOfKubernetes/sextant/wiki/Building-from-source) and [Development](https://github.com/FriendsOfKubernetes/sextant/wiki/Development)

## Community

Questions, ideas and projects go to [Discussions](https://github.com/FriendsOfKubernetes/sextant/discussions):
[Q&A](https://github.com/FriendsOfKubernetes/sextant/discussions/categories/q-a) for help,
[Ideas](https://github.com/FriendsOfKubernetes/sextant/discussions/categories/ideas) for suggestions,
[Show and tell](https://github.com/FriendsOfKubernetes/sextant/discussions/categories/show-and-tell) for what you built.
Found a bug? [Open an issue](https://github.com/FriendsOfKubernetes/sextant/issues/new/choose).

## Roadmap

What we plan for the next releases. Each release is a [milestone](https://github.com/FriendsOfKubernetes/sextant/milestones)
with one issue per feature; plans can change, and ideas are welcome in
[Discussions](https://github.com/FriendsOfKubernetes/sextant/discussions/categories/ideas).

| Release | Focus | What it brings |
|---|---|---|
| [0.9](https://github.com/FriendsOfKubernetes/sextant/milestone/12) | Everyday work *(in progress)* | Command palette (Ctrl+K), logs of several pods at once, debug containers, copying files to and from containers, rollout history with rollback, background notifications (can be turned off), cluster problems screen |
| [0.10](https://github.com/FriendsOfKubernetes/sextant/milestone/13) | Understanding the cluster | Right-sizing of requests and limits, cert-manager and certificate expiry, resource map, RBAC "who can do what" |
| [0.11](https://github.com/FriendsOfKubernetes/sextant/milestone/14) | Safer changes | Dry-run and diff before applying, cluster upgrade readiness (deprecated APIs), security posture (Pod Security Standards, Trivy reports), overview of several clusters |
| [0.12](https://github.com/FriendsOfKubernetes/sextant/milestone/15) | Troubleshooting | Change timeline, autoscaling insights (HPA, KEDA, Karpenter), cluster hygiene, network connectivity check |
| [0.13](https://github.com/FriendsOfKubernetes/sextant/milestone/16) | Your workspace | Saved views and workspaces, kubeconfig management |
| [0.14](https://github.com/FriendsOfKubernetes/sextant/milestone/17) | Power tools | YAML editor with the cluster's schema, storage insights (PVC usage, snapshots, Velero), cost view (OpenCost), terminal panes and snippets |

Further out: service mesh views (Istio, Linkerd), code-signed installers ([#20](https://github.com/FriendsOfKubernetes/sextant/issues/20)),
a mobile app ([#17](https://github.com/FriendsOfKubernetes/sextant/issues/17)).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you,
as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
