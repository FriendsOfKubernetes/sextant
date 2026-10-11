#!/usr/bin/env bash
# Test Kubernetes cluster for Sextant: kind cluster `sextant-test` + metrics-server + fixtures.
#
#   scripts/test-cluster.sh up                  create (or reuse) the cluster and apply everything
#   scripts/test-cluster.sh kubeconfig          print the path of the admin kubeconfig
#   scripts/test-cluster.sh kubeconfig limited  print the path of a kubeconfig for the `limited`
#                                               ServiceAccount (no access to Secrets)
#   scripts/test-cluster.sh down                delete the cluster
#
# Files live in $SEXTANT_TEST_DIR (default: ~/.cache/sextant-test).
# Subdirectories of scripts/fixtures/ that contain an `install.sh` are run after the base fixtures
# (each gets KUBECONFIG exported); that is how optional extras such as Prometheus plug in.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

CLUSTER_NAME="sextant-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
STATE_DIR="${SEXTANT_TEST_DIR:-$HOME/.cache/sextant-test}"
ADMIN_KUBECONFIG="$STATE_DIR/kubeconfig"
LIMITED_KUBECONFIG="$STATE_DIR/kubeconfig-limited"
METRICS_SERVER_URL="${METRICS_SERVER_URL:-https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml}"
DEMO_NS="sextant-demo"

log() { printf '[test-cluster] %s\n' "$*" >&2; }
die() { printf '[test-cluster] error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"; }

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; }

kc() { kubectl --kubeconfig "$ADMIN_KUBECONFIG" "$@"; }

write_admin_kubeconfig() {
  mkdir -p "$STATE_DIR"
  kind get kubeconfig --name "$CLUSTER_NAME" >"$ADMIN_KUBECONFIG.tmp"
  chmod 600 "$ADMIN_KUBECONFIG.tmp"
  mv "$ADMIN_KUBECONFIG.tmp" "$ADMIN_KUBECONFIG"
}

install_metrics_server() {
  log "installing metrics-server"
  local manifest="$STATE_DIR/metrics-server.yaml"
  if [[ ! -s "$manifest" ]]; then
    curl -fsSL "$METRICS_SERVER_URL" -o "$manifest.tmp"
    mv "$manifest.tmp" "$manifest"
  fi
  kc apply -f "$manifest" >/dev/null
  # kind kubelets use self-signed serving certificates.
  if ! kc -n kube-system get deployment metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' |
    grep -q -- '--kubelet-insecure-tls'; then
    kc -n kube-system patch deployment metrics-server --type=json \
      -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
  fi
}

apply_fixtures() {
  log "applying fixtures"
  kc apply -f "$FIXTURES_DIR/00-namespace.yaml" >/dev/null
  kc apply -f "$FIXTURES_DIR/40-crd.yaml" >/dev/null
  kc wait --for condition=established --timeout=60s crd/widgets.demo.sextant.dev >/dev/null
  local f
  for f in "$FIXTURES_DIR"/*.yaml; do
    kc apply -f "$f" >/dev/null
  done
  local extra
  for extra in "$FIXTURES_DIR"/*/install.sh; do
    [[ -f "$extra" ]] || continue
    log "running $(basename "$(dirname "$extra")")/install.sh"
    KUBECONFIG="$ADMIN_KUBECONFIG" bash "$extra"
  done
}

write_limited_kubeconfig() {
  local token="" i
  for i in $(seq 1 60); do
    token="$(kc -n "$DEMO_NS" get secret limited-token -o jsonpath='{.data.token}' 2>/dev/null || true)"
    [[ -n "$token" ]] && break
    sleep 1
  done
  [[ -n "$token" ]] || die "token for ServiceAccount 'limited' was not issued"
  token="$(printf '%s' "$token" | base64 -d)"
  local server ca
  server="$(kc config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')"
  ca="$(kc config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  mkdir -p "$STATE_DIR"
  umask 077
  cat >"$LIMITED_KUBECONFIG.tmp" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: $CLUSTER_NAME
    cluster:
      server: $server
      certificate-authority-data: $ca
users:
  - name: limited
    user:
      token: $token
contexts:
  - name: $CLUSTER_NAME-limited
    context:
      cluster: $CLUSTER_NAME
      user: limited
      namespace: $DEMO_NS
current-context: $CLUSTER_NAME-limited
EOF
  mv "$LIMITED_KUBECONFIG.tmp" "$LIMITED_KUBECONFIG"
}

wait_ready() {
  log "waiting for workloads"
  kc -n kube-system rollout status deployment/metrics-server --timeout=180s >/dev/null
  kc -n "$DEMO_NS" rollout status deployment/nginx --timeout=180s >/dev/null
  log "waiting for metrics (kubectl top pods -n $DEMO_NS)"
  local i
  for i in $(seq 1 60); do
    if kc top pods -n "$DEMO_NS" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  die "metrics-server did not start serving metrics"
}

cmd_up() {
  need kind
  need kubectl
  need docker
  need curl
  if cluster_exists; then
    log "cluster $CLUSTER_NAME already exists"
  else
    log "creating kind cluster $CLUSTER_NAME"
    mkdir -p "$STATE_DIR"
    # --kubeconfig keeps the user's ~/.kube/config untouched.
    kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$ADMIN_KUBECONFIG" --wait 180s >&2
  fi
  write_admin_kubeconfig
  install_metrics_server
  apply_fixtures
  write_limited_kubeconfig
  wait_ready
  log "ready; KUBECONFIG=$ADMIN_KUBECONFIG"
}

cmd_kubeconfig() {
  local which="${1:-admin}"
  cluster_exists || die "cluster $CLUSTER_NAME is not running (run: scripts/test-cluster.sh up)"
  [[ -s "$ADMIN_KUBECONFIG" ]] || write_admin_kubeconfig
  case "$which" in
    admin) echo "$ADMIN_KUBECONFIG" ;;
    limited)
      [[ -s "$LIMITED_KUBECONFIG" ]] || write_limited_kubeconfig
      echo "$LIMITED_KUBECONFIG"
      ;;
    *) die "unknown kubeconfig '$which' (expected: limited)" ;;
  esac
}

cmd_down() {
  need kind
  if cluster_exists; then
    kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$ADMIN_KUBECONFIG" >&2
  fi
  rm -f "$ADMIN_KUBECONFIG" "$LIMITED_KUBECONFIG"
}

case "${1:-}" in
  up) cmd_up ;;
  kubeconfig) cmd_kubeconfig "${2:-admin}" ;;
  down) cmd_down ;;
  *)
    echo "usage: $0 up | kubeconfig [limited] | down" >&2
    exit 2
    ;;
esac
