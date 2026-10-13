# ADR-0014: Secret values do not reach the window until they are asked for

## Context

A Secret arrived in the window whole: the base64 from `data` lay in every snapshot and delta of the table and in the details panel's watch, and was hidden only on screen. The project rule is "secrets do not go to the frontend except for display on click".

## Decision

When serializing a core/v1 Secret, the core replaces every `data` and `stringData` value with `""` (the keys stay), adds the marker `sextant.dev/values-hidden: "true"` to `metadata.annotations` and strips `kubectl.kubernetes.io/last-applied-configuration`. This applies to both watch and `resource_get`. The window requests the value of one key with the command `secret_value(clusterId, namespace, name, key)`: the core returns it decoded as UTF-8, and a non-UTF-8 value gives `invalid` with the text "binary value, N bytes". "Edit" on a Secret is an explicit action; it loads the whole object with the command `resource_get_full`, and the editor calls it only for Secrets. Saving (replace and apply) text that carries the marker is rejected with the code `invalid`: "reload the secret before saving". After saving, the editor re-reads the object through `resource_get_full`.

Supersedes ADR-0004 in the part "Secret data reaches the frontend together with the other objects".

## Why

- Masking in the window (`maskSecret`, `maskedAnnotation`), as it was, was rejected: the data still sits in the window's memory and in every message, while the project rule is about the data itself, not about what is drawn.
- Loading the whole Secret on "show" was rejected: for the sake of one key, all of them would go to the window.
- The marker is needed because an empty string is a valid value, so "hidden" cannot be told from "empty" by it. Without the marker, editing a hidden object and saving would overwrite the real values with empty ones.

## Consequences

- Any new function that needs Secret data goes through `secret_value` or `resource_get_full`. Ordinary replies know nothing about them.
- Every display of a value is a separate request to the cluster. Binary values cannot be shown, only their length read from the error.
- The marker is visible in the YAML view and in annotations. Text copied from there will not be saved, and this is deliberate.
- Viewing a Secret no longer shows `last-applied-configuration`: the stripping is done by the backend. The whole object (Edit) still contains it.
- Helm is not affected: its Secrets are read by the core, and `HelmReleaseDetail` goes to the window.
