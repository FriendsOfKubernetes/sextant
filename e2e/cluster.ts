// Node-side helpers of the end-to-end tests: the test cluster (`scripts/test-cluster.sh`), kubectl and helm.
// Nothing here touches ~/.kube/config: every call passes the test cluster's kubeconfig explicitly.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NAMESPACE = "sextant-e2e";
export const CONTEXT = "kind-sextant-test";
export const RELEASE = "e2e-release";
const FIXTURES = path.join(ROOT, "e2e", "fixtures");

/** PATH with the usual places of the developer tools (cargo, ~/.local/bin). */
export function toolPath(): string {
  const extra = [path.join(homedir(), ".cargo", "bin"), path.join(homedir(), ".local", "bin")];
  return [...extra, process.env.PATH ?? ""].join(path.delimiter);
}

/** Admin kubeconfig of `sextant-test`: `SEXTANT_TEST_KUBECONFIG`, else what `scripts/test-cluster.sh` prints. */
export function testKubeconfig(): string {
  const fromEnv = process.env.SEXTANT_TEST_KUBECONFIG;
  const file = fromEnv
    ? fromEnv
    : execFileSync(path.join(ROOT, "scripts", "test-cluster.sh"), ["kubeconfig"], {
        encoding: "utf8",
        env: { ...process.env, PATH: toolPath() },
      }).trim();
  if (!existsSync(file)) {
    throw new Error(`kubeconfig ${file} not found — start the test cluster with scripts/test-cluster.sh up --prometheus`);
  }
  return file;
}

function run(cmd: string, args: string[], input?: string): string {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: toolPath() },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function kubectl(...args: string[]): string {
  return run("kubectl", ["--kubeconfig", testKubeconfig(), ...args]);
}

/** `helm` against the test cluster, with its config and cache in `helmHome` (not the developer's). */
export function helm(helmHome: string, ...args: string[]): string {
  const env = [
    `HELM_CONFIG_HOME=${path.join(helmHome, "config")}`,
    `HELM_CACHE_HOME=${path.join(helmHome, "cache")}`,
    `HELM_DATA_HOME=${path.join(helmHome, "data")}`,
  ];
  return run("env", [...env, "helm", "--kubeconfig", testKubeconfig(), "--kube-context", CONTEXT, ...args]);
}

/** Creates `sextant-e2e` with its fixtures and a Helm release; waits until the pod is ready. */
export function setUpCluster(helmHome: string): void {
  kubectl("get", "--raw", "/readyz");
  tearDownCluster(helmHome);
  kubectl("apply", "-f", path.join(FIXTURES, "e2e.yaml"));
  helm(helmHome, "install", RELEASE, path.join(FIXTURES, "chart"), "--namespace", NAMESPACE, "--wait");
  kubectl("-n", NAMESPACE, "rollout", "status", "deployment/e2e-web", "--timeout=180s");
}

/** Removes everything the tests created (the release and the namespace). */
export function tearDownCluster(helmHome: string): void {
  try {
    helm(helmHome, "uninstall", RELEASE, "--namespace", NAMESPACE, "--wait");
  } catch {
    // Not installed (first run or already removed).
  }
  kubectl("delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true", "--timeout=180s");
}

/** Name of the first pod of `e2e-web`. */
export function webPod(): string {
  return kubectl("-n", NAMESPACE, "get", "pods", "-l", "app=e2e-web", "-o", "jsonpath={.items[0].metadata.name}").trim();
}

/** Whether the test cluster serves the CRD `name` (e.g. `kustomizations.kustomize.toolkit.fluxcd.io`). */
export function hasCrd(name: string): boolean {
  try {
    kubectl("get", "crd", name, "-o", "name");
    return true;
  } catch {
    return false;
  }
}
