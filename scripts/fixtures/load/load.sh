#!/usr/bin/env bash
# Load fixture for the kind test cluster: a cluster the size of a real one, to time the first load.
#
#   scripts/fixtures/load/load.sh apply    150 CRDs (30 groups *.load.sextant.dev, two served versions each, schemas
#                                          of ~15 KB per version) and 500 pods in namespace `sextant-load`
#                                          (a Deployment whose pods match no node: they stay Pending, cost no CPU)
#   scripts/fixtures/load/load.sh delete   removes all of it
#
# Not applied by `scripts/test-cluster.sh up` (it only runs `*/install.sh`): apply it for the timing test in
# crates/sextant-core/tests/watch.rs and delete it afterwards. Uses the admin kubeconfig of the test cluster
# ($SEXTANT_TEST_KUBECONFIG, else `scripts/test-cluster.sh kubeconfig`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="sextant-load"
GROUP_SUFFIX="load.sextant.dev"
GROUPS_COUNT=30
KINDS_PER_GROUP=5
PODS=500
FIELDS=60

KUBECONFIG_PATH="${SEXTANT_TEST_KUBECONFIG:-$("$SCRIPT_DIR/../../test-cluster.sh" kubeconfig)}"
kc() { kubectl --kubeconfig "$KUBECONFIG_PATH" "$@"; }
log() { printf '[load] %s\n' "$*" >&2; }

# The openAPIV3Schema of one version: `spec` with $FIELDS described string fields.
schema() {
  local f
  printf '        openAPIV3Schema:\n          type: object\n          properties:\n            spec:\n              type: object\n              properties:\n'
  for ((f = 0; f < FIELDS; f++)); do
    printf '                field%d:\n                  type: string\n                  description: "Field %d of the load fixture. It is long on purpose, like the descriptions of real CRDs generated from Go types, so that the list of all CRDs weighs megabytes."\n' "$f" "$f"
  done
}

crds() {
  local g k group kind plural
  for ((g = 0; g < GROUPS_COUNT; g++)); do
    group="g$g.$GROUP_SUFFIX"
    for ((k = 0; k < KINDS_PER_GROUP; k++)); do
      kind="Load$k"
      plural="load${k}s"
      printf -- '---\napiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: %s.%s\n  labels:\n    sextant.dev/fixture: load\nspec:\n  group: %s\n  scope: Namespaced\n  names:\n    kind: %s\n    plural: %s\n    singular: load%d\n  versions:\n' \
        "$plural" "$group" "$group" "$kind" "$plural" "$k"
      for version in v1 v1beta1; do
        printf '    - name: %s\n      served: true\n      storage: %s\n      additionalPrinterColumns:\n        - name: Field0\n          type: string\n          jsonPath: .spec.field0\n      schema:\n' \
          "$version" "$([[ $version == v1 ]] && echo true || echo false)"
        schema
      done
    done
  done
}

pods() {
  cat <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $NAMESPACE
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pending
  namespace: $NAMESPACE
spec:
  replicas: $PODS
  selector:
    matchLabels:
      app: pending
  template:
    metadata:
      labels:
        app: pending
    spec:
      # No node has this label: the pods are never scheduled and run nothing.
      nodeSelector:
        sextant.dev/no-such-node: "true"
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
YAML
}

case "${1:-}" in
  apply)
    log "creating $((GROUPS_COUNT * KINDS_PER_GROUP)) CRDs"
    crds | kc apply --server-side --force-conflicts -f - >/dev/null
    kc wait --for condition=established --timeout=180s crd -l sextant.dev/fixture=load >/dev/null
    log "creating $PODS pending pods in $NAMESPACE"
    pods | kc apply -f - >/dev/null
    for _ in $(seq 1 120); do
      count="$(kc -n "$NAMESPACE" get pods --no-headers 2>/dev/null | wc -l | tr -d ' ')"
      [[ "$count" -ge "$PODS" ]] && break
      sleep 2
    done
    log "ready: $(kc get crd -l sextant.dev/fixture=load --no-headers | wc -l | tr -d ' ') CRDs, $count pods"
    ;;
  delete)
    log "deleting namespace $NAMESPACE and the load CRDs"
    kc delete namespace "$NAMESPACE" --ignore-not-found --wait=false >/dev/null
    kc delete crd -l sextant.dev/fixture=load --ignore-not-found >/dev/null
    ;;
  *)
    echo "usage: $0 apply | delete" >&2
    exit 2
    ;;
esac
