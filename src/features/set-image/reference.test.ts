import { describe, expect, it } from "vitest";
import { checkImage, type ImageError, type ImageWarning } from "./reference";

const SHA256 = `sha256:${"a".repeat(64)}`;

describe("image references", () => {
  it.each<[string, string | null, string, string | null, string | null, ImageWarning | null]>([
    // text, host, path, tag, digest, warning
    ["nginx:1.27", null, "nginx", "1.27", null, null],
    ["nginx", null, "nginx", null, null, "noTag"],
    ["nginx:latest", null, "nginx", "latest", null, "latest"],
    ["library/nginx:1.27-alpine", null, "library/nginx", "1.27-alpine", null, null],
    ["ghcr.io/acme/web:v2.0.1", "ghcr.io", "acme/web", "v2.0.1", null, null],
    ["registry.example.com:5000/team/app:1", "registry.example.com:5000", "team/app", "1", null, null],
    ["localhost:5000/app:dev", "localhost:5000", "app", "dev", null, null],
    ["localhost/app:dev", "localhost", "app", "dev", null, null],
    // A first part with a port is a registry host.
    ["nginx:1/two", "nginx:1", "two", null, null, "noTag"],
    ["[::1]:5000/app:1", "[::1]:5000", "app", "1", null, null],
    ["my_app__x/sub.part-a--b:_Tag.1-x", null, "my_app__x/sub.part-a--b", "_Tag.1-x", null, null],
    [`nginx@${SHA256}`, null, "nginx", null, SHA256, null],
    [`nginx:latest@${SHA256}`, null, "nginx", "latest", SHA256, null],
    [`quay.io/a/b:1@sha512:${"F".repeat(128)}`, "quay.io", "a/b", "1", `sha512:${"F".repeat(128)}`, null],
    [`app@multihash+base58:${"0".repeat(32)}`, null, "app", null, `multihash+base58:${"0".repeat(32)}`, null],
    [`nginx:${"t".repeat(128)}`, null, "nginx", "t".repeat(128), null, null],
  ])("%s is valid", (text, host, path, tag, digest, warning) => {
    expect(checkImage(text)).toEqual({ ok: true, reference: { host, path, tag, digest }, warning });
  });

  it.each<[string, ImageError]>([
    ["", "empty"],
    ["nginx :1", "spaces"],
    [" nginx:1", "spaces"],
    ["nginx:1\t", "spaces"],
    ["Nginx:1", "uppercase"],
    ["acme/Web:1", "uppercase"],
    ["nginx:", "tag"],
    ["nginx:.1", "tag"],
    ["nginx:-1", "tag"],
    [`nginx:${"t".repeat(129)}`, "tag"],
    ["nginx:1+2", "tag"],
    ["nginx@", "digest"],
    ["nginx@sha256:abc", "digest"],
    [`nginx@sha256:${"a".repeat(63)}`, "digest"],
    [`nginx@sha256:${"g".repeat(64)}`, "digest"],
    [`nginx@1sha:${"a".repeat(64)}`, "digest"],
    [`nginx@${SHA256}@${SHA256}`, "digest"],
    ["/nginx:1", "name"],
    ["nginx/:1", "name"],
    ["acme//web", "name"],
    ["-web:1", "name"],
    ["web.:1", "name"],
    ["a...b", "name"],
    ["bad_host_.io/app:1", "host"],
    ["-bad.io/app:1", "host"],
    ["host.io:port/app:1", "host"],
    [`${"a".repeat(256)}:1`, "tooLong"],
  ])("%j is refused as %s", (text, error) => {
    expect(checkImage(text)).toEqual({ ok: false, error });
  });
});
