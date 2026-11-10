// The masking of a k3s/RKE2 node's arguments (ADR-0123), kept from the former built-in k3s view's tests.
import { describe, expect, it } from "vitest";
import { nodeArgs, secretFlag } from "./nodeArgs";

const SERVER = JSON.stringify([
  "server",
  "--cluster-init",
  "--disable",
  "traefik",
  "--token",
  "********",
  "--etcd-s3-secret-key",
  "plain-old-secret",
  "--kube-apiserver-arg",
  "oidc-client-secret=abc123",
  "--tls-san",
  "k3s.example.com",
  "--write-kubeconfig-mode=0644",
]);
const AGENT = JSON.stringify(["agent", "--server", "https://k3s:k3s-pass@10.0.0.11:6443", "--token", "********"]);
const RKE2 = JSON.stringify(["server", "--cni", "canal", "--token", "********", "--datastore-endpoint", "postgres://rke2:hunter2@db.example.com:5432/rke2"]);
const SECRETS = ["plain-old-secret", "abc123", "hunter2", "k3s-pass"];

describe("node arguments", () => {
  it("hides every secret value, k3s's own mask included, and keeps the rest", () => {
    const args = nodeArgs(SERVER)!;
    expect(args).toEqual([
      { value: "server", hidden: false },
      { flag: "--cluster-init", hidden: false },
      { flag: "--disable", value: "traefik", hidden: false },
      { flag: "--token", hidden: true },
      { flag: "--etcd-s3-secret-key", hidden: true },
      { flag: "--kube-apiserver-arg", hidden: true },
      { flag: "--tls-san", value: "k3s.example.com", hidden: false },
      { flag: "--write-kubeconfig-mode", value: "0644", hidden: false },
    ]);
    const all = JSON.stringify([args, nodeArgs(AGENT), nodeArgs(RKE2)]);
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    expect(nodeArgs(RKE2)).toContainEqual({ flag: "--datastore-endpoint", hidden: true });
    expect(nodeArgs("not json")).toBeNull();
    expect(nodeArgs("[1, 2]")).toBeNull();
    expect(nodeArgs(undefined)).toBeUndefined();
  });

  it.each([
    ["--token", undefined, true],
    ["-t", undefined, true],
    ["--agent-token", undefined, true],
    ["--datastore-endpoint", undefined, true],
    ["--etcd-s3-access-key", undefined, true],
    ["--etcd-s3-session-token", undefined, true],
    ["--vpn-auth", undefined, true],
    ["--kubelet-arg", "max-pods=110", false],
    ["--kube-apiserver-arg", "oidc-client-secret=x", true],
    ["--disable", "traefik", false],
    ["--node-taint", "a=b:NoSchedule", false],
  ])("%s %s → secret %s", (flag, value, secret) => {
    expect(secretFlag(flag, value)).toBe(secret);
  });
});
