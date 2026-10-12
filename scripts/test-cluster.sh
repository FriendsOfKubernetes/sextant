#!/usr/bin/env bash
# Test Kubernetes cluster for Sextant: kind cluster `sextant-test` + metrics-server + fixtures.
#
#   scripts/test-cluster.sh up                  create (or reuse) the cluster and apply everything
#   scripts/test-cluster.sh up --prometheus     the same, plus a minimal Prometheus in namespace `monitoring`
#                                               (scripts/fixtures/prometheus/, service prometheus-operated:9090)
#   scripts/test-cluster.sh up --gitops         the same, plus Flux (flux-system) and Argo CD (argocd) of fixed
#                                               versions from their official manifests, and the fixtures of
#                                               scripts/fixtures/gitops/ (namespaces sextant-flux, sextant-argo);
#                                               flags combine: up --prometheus --gitops
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
# GitOps tools for `up --gitops`: fixed versions, official release manifests (cached in $STATE_DIR).
FLUX_VERSION="v2.9.6"
ARGOCD_VERSION="v3.5.5"
FLUX_URL="https://github.com/fluxcd/flux2/releases/download/$FLUX_VERSION/install.yaml"
ARGOCD_URL="https://raw.githubusercontent.com/argoproj/argo-cd/$ARGOCD_VERSION/manifests/install.yaml"

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

install_prometheus() {
  log "installing Prometheus (namespace monitoring)"
  kc apply -f "$FIXTURES_DIR/prometheus/prometheus.yaml" >/dev/null
  kc -n monitoring rollout status deployment/prometheus --timeout=300s >/dev/null
  log "waiting for the first scrapes"
  local i
  for i in $(seq 1 60); do
    if kc get --raw "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy/api/v1/query?query=count(container_memory_working_set_bytes)" 2>/dev/null |
      grep -q '"result":\[{'; then
      return 0
    fi
    sleep 5
  done
  die "Prometheus did not collect metrics"
}

# Downloads `url` once into $STATE_DIR/`name` (kept for the next run) and prints the path.
cached_manifest() {
  local url="$1" name="$2"
  local manifest="$STATE_DIR/$name"
  if [[ ! -s "$manifest" ]]; then
    curl -fsSL "$url" -o "$manifest.tmp"
    mv "$manifest.tmp" "$manifest"
  fi
  echo "$manifest"
}

install_gitops() {
  log "installing Flux $FLUX_VERSION (namespace flux-system)"
  local flux argocd
  flux="$(cached_manifest "$FLUX_URL" "flux-$FLUX_VERSION.yaml")"
  # Server-side: the CRDs are too big for the last-applied annotation of a client-side apply.
  kc apply --server-side --force-conflicts -f "$flux" >/dev/null
  log "installing Argo CD $ARGOCD_VERSION (namespace argocd)"
  argocd="$(cached_manifest "$ARGOCD_URL" "argocd-$ARGOCD_VERSION.yaml")"
  kc create namespace argocd --dry-run=client -o yaml | kc apply -f - >/dev/null
  kc -n argocd apply --server-side --force-conflicts -f "$argocd" >/dev/null

  kc wait --for condition=established --timeout=120s \
    crd/gitrepositories.source.toolkit.fluxcd.io crd/kustomizations.kustomize.toolkit.fluxcd.io \
    crd/helmrepositories.source.toolkit.fluxcd.io crd/helmreleases.helm.toolkit.fluxcd.io \
    crd/applications.argoproj.io crd/applicationsets.argoproj.io crd/appprojects.argoproj.io >/dev/null

  log "waiting for the Flux and Argo CD controllers"
  kc -n flux-system wait --for condition=available --timeout=300s deployment --all >/dev/null
  kc -n argocd wait --for condition=available --timeout=300s deployment --all >/dev/null
  kc -n argocd rollout status statefulset/argocd-application-controller --timeout=300s >/dev/null

  log "applying GitOps fixtures"
  local f
  for f in "$FIXTURES_DIR"/gitops/*.yaml; do
    kc apply -f "$f" >/dev/null
  done
  # The fixtures fetch public repositories: their readiness depends on the network, so it is waited for but
  # not required.
  if ! kc -n sextant-flux wait --for condition=ready --timeout=180s \
    gitrepository/podinfo kustomization/podinfo helmrelease/podinfo-helm >/dev/null 2>&1; then
    log "warning: Flux fixtures are not Ready yet (kubectl -n sextant-flux get gitrepository,kustomization,helmrelease)"
  fi
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

# `up [--prometheus] [--gitops]`
cmd_up_with() {
  local prometheus=0 gitops=0 flag
  for flag in "$@"; do
    case "$flag" in
      --prometheus) prometheus=1 ;;
      --gitops) gitops=1 ;;
      *) die "unknown flag '$flag' (expected: --prometheus, --gitops)" ;;
    esac
  done
  cmd_up
  if ((prometheus)); then
    install_prometheus
    log "Prometheus ready: monitoring/prometheus-operated:9090"
  fi
  if ((gitops)); then
    install_gitops
    log "GitOps ready: Flux $FLUX_VERSION in flux-system, Argo CD $ARGOCD_VERSION in argocd"
  fi
}

case "${1:-}" in
  up)
    shift
    cmd_up_with "$@"
    ;;
  kubeconfig) cmd_kubeconfig "${2:-admin}" ;;
  down) cmd_down ;;
  *)
    echo "usage: $0 up [--prometheus] [--gitops] | kubeconfig [limited] | down" >&2
    exit 2
    ;;
esac
