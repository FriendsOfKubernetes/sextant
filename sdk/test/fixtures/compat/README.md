# Frozen extensions (ADR-0142)

These packages were built by earlier SDKs and are kept byte for byte. **Never rebuild, re-sign or edit them.** They
are what users have installed. Today's Sextant and SDK must keep running them, and the tests that run them are:

- `crates/sextant-core/src/extensions/compat_tests.rs`
- `crates/sextant-ext-runtime/tests/compat.rs`
- `sdk/test/compat.test.ts`
- `sdk/test/compat-protocol.test.ts`

| File | API | Built by | SHA-256 |
|---|---|---|---|
| `sdk-0.6.0/sextant.example.hello-page-1.0.0.sextant-ext` | 1 | the SDK at tag `v0.6.0` (`sdk:build` + `sdk:pack` of its `sdk/examples/hello-page`) | `3e1fb42369af9b7e29cb35c8af9928f60dbe220a5209b52f9c2637e76e371a38` |
| `sdk-0.6.0/sextant.example.crd-view-1.0.0.sextant-ext` | 1 | the SDK at tag `v0.6.0` (its `sdk/examples/crd-view`) | `6710a2d62884a2283116e2de2e2d4c4fabccf12cb1287e0f4e5c37d74083ea55` |
| `sdk-0.26.0/sextant.example.backend-rust-1.0.0.sextant-ext` | 1 | the SDK at tag `v0.26.0` (its `sdk/examples/backend-rust`, cargo for `wasm32-wasip2`) | `791af8701ce0629c2def3ecca8ba0b683284322d27d960fe1413f0463070e23b` |
| `published/sextant.example.hello-page-1.0.0.sextant-ext` | 1 | the release `hello-page-v1.0.0` of FriendsOfKubernetes/sextant-extension-examples (SDK 0.26) | `d36908831af41a57fa429d138c8c91b1ff39b91f7fe22f672edd53681d55a217` |
| `published/sextant.example.crd-view-1.0.0.sextant-ext` | 1 | the release `crd-view-v1.0.0` of FriendsOfKubernetes/sextant-extension-examples (SDK 0.26) | `c66ace1fc751106f6bc3a010b0acaccd6fc52f49ec2b7cb99810805b41adc456` |
| `published/sextant.rook-ceph-1.0.0.sextant-ext` | 2 | the release `rook-ceph-v1.0.0` of FriendsOfKubernetes/sextant-extensions (SDK 0.28.0) | `fcb439336280c8fdd27823b3fcdeb714e445b50e505e1b67b0ef7fcbaf3f40ce` |
| `published/sextant.rook-ceph-1.1.1.sextant-ext` | 2 | the release `rook-ceph-v1.1.1` of FriendsOfKubernetes/sextant-extensions (SDK 0.28.1) | `d7de956caa92f5e98cd08abc6dfff62c81f6add0a4518aa67832905f520182a2` |
| `sdk-0.29.0/sextant.example.crd-view-1.1.0.sextant-ext` | 3 | the SDK of the release `v0.29.0` (`sdk:build` + `sdk:pack` of its `sdk/examples/crd-view`) | `3a9f2850323c4b3fc5c190a0c3bef3d17360da6b0ffc7d480f74345ebe322f23` |
| `published/sextant.rook-ceph-1.2.0.sextant-ext` | 3 | the release `rook-ceph-v1.2.0` of FriendsOfKubernetes/sextant-extensions (SDK 0.29) | `d525cc3d4f08a20eca5e32afd7005f064899f8867c8be694fade73419b5795db` |
| `published/sextant.argo-rollouts-1.4.0.sextant-ext` | 4 | the release `argo-rollouts-v1.4.0` of FriendsOfKubernetes/sextant-extensions (SDK 0.30.0) | `743912892cafa8daa97a84c91c3858eb4b48541d2fdc55ec25d10e495f2d0146` |
| `published/sextant.cert-manager-1.0.0.sextant-ext` | 4 | the release `cert-manager-v1.0.0` of FriendsOfKubernetes/sextant-extensions (SDK 0.30.0) | `78f0900c30151115436ffbbd24f152f0fce8a2391f480d8ed7ae34d833195b76` |

The `published/` files equal the release assets: their SHA-256 is the `digest` GitHub shows for each.

**`settings-<version>.json`.** These are the `extensions` entries of a `settings.json` as that Sextant wrote them at
consent:
- `granted` holds the manifest's permissions, with `confirm` written out;
- `grantedBackend`, `grantedProblems`, `grantedMetricQueries` and `grantedCommands` appear only in versions that had them;
- `settings-0.30.0.json` is written as 0.30.0's install from the catalog writes it, with the catalog source.

Each entry names a package above by id and version.

**`projects/hello-page-0.6.0/`.** This is the hello-page source at `v0.6.0`, without its tests. Today's SDK must
type-check it (it is in `sdk/tsconfig.json`) and build it unchanged.

**Adding to the set.** A release that changes the extension API adds packages built by it:
- for a new `sextantApi`, at least one example of that version;
- each new file gets a row here and a scenario in `sdk/test/compat.test.ts`.

The test `every frozen package is covered here` fails until the scenario is there.
