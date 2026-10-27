import { describe, expect, it } from "vitest";
import { shownAnnotation } from "./secrets";

describe("annotations that hold secrets", () => {
  it("a k3s/RKE2 node's arguments are shown with every secret value hidden", () => {
    const args = JSON.stringify(["server", "--token", "K10s3cret", "--disable", "traefik", "--datastore-endpoint=postgres://u:p@db:5432/k3s"]);
    const shown = shownAnnotation("Node", "k3s.io/node-args", args)!;
    expect(shown).not.toContain("s3cret");
    expect(shown).not.toContain("u:p@");
    expect(JSON.parse(shown)).toEqual(["server", "--token", "<hidden>", "--disable", "traefik", "--datastore-endpoint", "<hidden>"]);
    expect(shownAnnotation("Node", "rke2.io/node-args", "not json")).toBeNull();
  });

  it("a node's environment is shown with secret-looking variables hidden", () => {
    const env = JSON.stringify({ K3S_TOKEN: "K10s3cret", K3S_DATASTORE_ENDPOINT: "etcd", K3S_NODE_NAME: "server-0", K3S_URL: "https://u:p@10.0.0.1:6443" });
    const shown = JSON.parse(shownAnnotation("Node", "k3s.io/node-env", env)!) as Record<string, string>;
    expect(shown.K3S_TOKEN).toBe("<hidden>");
    expect(shown.K3S_DATASTORE_ENDPOINT).toBe("<hidden>");
    expect(shown.K3S_NODE_NAME).toBe("server-0");
    expect(shown.K3S_URL).not.toContain("u:p@");
    expect(shownAnnotation("Node", "rke2.io/node-env", "[1]")).toBeNull();
  });

  it("other annotations and other kinds are shown as they are; a Secret's last-applied never", () => {
    expect(shownAnnotation("Node", "k3s.io/node-config-hash", "ABC")).toBe("ABC");
    expect(shownAnnotation("ConfigMap", "k3s.io/node-args", '["--token","x"]')).toBe('["--token","x"]');
    expect(shownAnnotation("Secret", "kubectl.kubernetes.io/last-applied-configuration", "{}")).toBeNull();
  });
});
