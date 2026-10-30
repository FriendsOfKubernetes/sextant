#!/usr/bin/env node
// Checks fixtures/objects.json against Rook's own CRDs: every Rook and ObjectBucketClaim object is created on a
// throwaway cluster (nothing runs Rook there, so nothing acts on them), its status is sent as a server-side dry run
// of the status subresource (a replace) with strict field validation, and everything is removed again; StorageClasses and
// claims are created as a dry run. Run it against Sextant's kind test cluster only:
//
//   node extensions/rook-ceph/fixtures/dry-run.mjs "$(scripts/test-cluster.sh kubeconfig)"
//
// The CRDs come from Rook's release (ROOK_VERSION); CRDs that were not there before are deleted at the end.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOK_VERSION = "v1.21.1";
const CRDS = `https://raw.githubusercontent.com/rook/rook/${ROOK_VERSION}/deploy/examples/crds.yaml`;
const kubeconfig = process.argv[2];
if (!kubeconfig) {
  process.stderr.write("usage: dry-run.mjs <kubeconfig of a throwaway cluster>\n");
  process.exit(2);
}
const kubectl = (args, input) =>
  execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

const fixtures = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "objects.json"), "utf8"));
const rook = [...fixtures.clusters, ...fixtures.pools, ...fixtures.filesystems, ...fixtures.objectStores, ...fixtures.others, ...fixtures.objectBucketClaims];
const dryOnly = [...fixtures.storageClasses, ...fixtures.pvcs];

/**
 * Fields of `value` that `schema` does not name. Rook declares its statuses with
 * `x-kubernetes-preserve-unknown-fields`, so the API server keeps an unknown status field instead of refusing it:
 * this walk is what catches a misspelt one.
 */
function unknownFields(value, schema, path) {
  if (value === null || typeof value !== "object" || !schema) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => unknownFields(item, schema.items, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, field]) => {
    const known = schema.properties?.[key];
    if (known) return unknownFields(field, known, `${path}.${key}`);
    if (typeof schema.additionalProperties === "object") return unknownFields(field, schema.additionalProperties, `${path}.${key}`);
    return [`${path}.${key}`];
  });
}
const schemas = new Map();
const schemaOf = (object) => {
  const [group, version] = object.apiVersion.split("/");
  const key = `${object.kind}.${group}`;
  if (!schemas.has(key)) {
    const crd = JSON.parse(kubectl(["get", "crd", "-o", "json"])).items.find(
      (c) => c.spec.group === group && c.spec.names.kind === object.kind,
    );
    schemas.set(key, crd.spec.versions.find((v) => v.name === version).schema.openAPIV3Schema);
  }
  return schemas.get(key);
};

/** The object as created by hand: no status, no fields the API server sets. */
const bare = (object) => {
  const copy = JSON.parse(JSON.stringify(object));
  delete copy.status;
  for (const field of ["uid", "resourceVersion", "creationTimestamp"]) delete copy.metadata[field];
  return copy;
};

const before = new Set(kubectl(["get", "crd", "-o", "name"]).split("\n").filter(Boolean));
const crdYaml = await (await globalThis.fetch(CRDS)).text();
kubectl(["apply", "--server-side", "-f", "-"], crdYaml);
const after = kubectl(["get", "crd", "-o", "name"]).split("\n").filter(Boolean);
const added = after.filter((name) => !before.has(name) && /\.(ceph\.rook\.io|objectbucket\.io)$/.test(name));
kubectl(["wait", "--for=condition=Established", "--timeout=60s", ...after.filter((n) => /ceph\.rook\.io|objectbucket\.io/.test(n))]);

const namespaces = [...new Set([...rook, ...dryOnly].map((o) => o.metadata.namespace).filter(Boolean))];
const createdNamespaces = namespaces.filter((ns) => {
  try {
    kubectl(["get", "namespace", ns]);
    return false;
  } catch {
    kubectl(["create", "namespace", ns]);
    return true;
  }
});

let failed = 0;
const created = [];
try {
  for (const object of rook) {
    const name = `${object.kind} ${object.metadata.namespace}/${object.metadata.name}`;
    try {
      const fields = { ...bare(object), status: object.status };
      delete fields.metadata;
      const unknown = unknownFields(fields, schemaOf(object), "");
      if (unknown.length) throw new Error(`fields Rook's CRD does not name: ${unknown.join(", ")}`);
      const saved = JSON.parse(kubectl(["create", "--validate=strict", "-o", "json", "-f", "-"], JSON.stringify(bare(object))));
      created.push(object);
      if (object.status) {
        kubectl(
          ["replace", "--subresource=status", "--dry-run=server", "--validate=strict", "-f", "-"],
          JSON.stringify({ ...saved, status: object.status }),
        );
      }
      process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL ${name}: ${String(err.stderr || err.message).trim()}\n`);
    }
  }
  for (const object of dryOnly) {
    const name = `${object.kind} ${object.metadata.namespace ?? ""}/${object.metadata.name}`;
    try {
      kubectl(["create", "--dry-run=server", "--validate=strict", "-f", "-"], JSON.stringify(bare(object)));
      process.stdout.write(`ok   ${name} (dry run)\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL ${name}: ${String(err.stderr || err.message).trim()}\n`);
    }
  }
} finally {
  for (const object of created.reverse()) {
    kubectl(["delete", "--wait=false", "-f", "-"], JSON.stringify(bare(object)));
  }
  // Nothing runs Rook here, so nothing removes Rook's finalizers: there are none on objects created by hand.
  for (const ns of createdNamespaces) kubectl(["delete", "namespace", ns, "--wait=true", "--timeout=120s"]);
  if (added.length) kubectl(["delete", ...added]);
}
process.stdout.write(failed ? `${failed} failed\n` : "every fixture is valid against Rook's CRDs\n");
process.exitCode = failed ? 1 : 0;
