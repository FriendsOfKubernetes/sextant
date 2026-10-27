import { describe, expect, it } from "vitest";
import shared from "./inline-secrets.json";
import { INLINE_SECRETS, hasInlineSecrets, isInlineSecretPath, replaceInlineSecrets } from "./inlineSecrets";

describe("inline secrets", () => {
  it("is the table the core has (inline-secrets.json, checked by the core's test too)", () => {
    expect(INLINE_SECRETS).toEqual(shared.kinds);
    expect(hasInlineSecrets("route.openshift.io", "Route")).toBe(true);
    expect(hasInlineSecrets("", "Secret")).toBe(false);
  });

  it.each(shared.paths)("tells $group/$kind $path as the core does", ({ group, kind, path, secret }) => {
    expect(isInlineSecretPath(group, kind, path)).toBe(secret);
  });

  it("takes a path that does not read as secret, only for a kind of the table", () => {
    expect(isInlineSecretPath("route.openshift.io", "Route", "spec..x")).toBe(true);
    expect(isInlineSecretPath("route.openshift.io", "Route", 'metadata.annotations["x')).toBe(true);
    expect(isInlineSecretPath("apps", "Deployment", "spec..x")).toBe(false);
  });

  it("replaces every value at the paths in a copy and leaves the rest", () => {
    const config = {
      spec: {
        triggers: [
          { type: "GitHub", github: { secret: "gh" } },
          { type: "Generic", generic: { secret: "gen", allowEnv: true } },
          { type: "GitLab", gitlab: { secretReference: { name: "hook" } } },
          { type: "ConfigChange" },
        ],
      },
    };
    const out = replaceInlineSecrets("build.openshift.io", "BuildConfig", config, () => "<x>");
    expect(out.spec.triggers).toEqual([
      { type: "GitHub", github: { secret: "<x>" } },
      { type: "Generic", generic: { secret: "<x>", allowEnv: true } },
      { type: "GitLab", gitlab: { secretReference: { name: "hook" } } },
      { type: "ConfigChange" },
    ]);
    // The object itself is not changed.
    expect(JSON.stringify(config)).toContain('"secret":"gh"');

    const chart = { spec: { chart: "traefik", set: { "global.password": "p", replicas: 2 }, valuesContent: "a: b" } };
    expect(replaceInlineSecrets("helm.cattle.io", "HelmChart", chart, () => "")).toEqual({
      spec: { chart: "traefik", set: { "global.password": "", replicas: "" }, valuesContent: "" },
    });

    const node = { metadata: { annotations: { "k3s.io/node-args": "[]", "k3s.io/node-config-hash": "A" } } };
    expect(replaceInlineSecrets("", "Node", node, () => "")).toEqual({
      metadata: { annotations: { "k3s.io/node-args": "", "k3s.io/node-config-hash": "A" } },
    });

    const deployment = { spec: { tls: { key: "k" } } };
    expect(replaceInlineSecrets("apps", "Deployment", deployment, () => "")).toBe(deployment);
  });
});
