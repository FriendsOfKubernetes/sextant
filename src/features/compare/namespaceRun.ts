// One namespace comparison: the bounded lists of both sides and, when Secrets are compared, the backend's comparison
// of the Secrets both namespaces have (by key names and value hashes; no value reaches the frontend).
import { api, toApiError, type ApiError, type CompareKindList, type KindRef, type KubeObject, type NamespaceSide, type SecretNamespaceComparison } from "../../api";
import { kindKey } from "../../resources/refs";
import { COMPARE_LIMIT } from "./kinds";
import { bucketize, type CompareRow, type IgnorePathsByKind } from "./model";
import { isSecretKind } from "./objects";

export interface NamespaceRequest {
  left: NamespaceSide;
  right: NamespaceSide;
  kinds: KindRef[];
}

export interface NamespaceResult {
  left: CompareKindList[];
  right: CompareKindList[];
  secrets: SecretNamespaceComparison | null;
  /** Why the Secrets' values could not be compared (their rows then compare the YAML only). */
  secretsError: ApiError | null;
}

export async function runNamespaceCompare(request: NamespaceRequest): Promise<NamespaceResult> {
  const withSecrets = request.kinds.some(isSecretKind);
  const [left, right, secrets] = await Promise.all([
    api.compare.list(request.left.clusterId, request.left.namespace, request.kinds, COMPARE_LIMIT),
    api.compare.list(request.right.clusterId, request.right.namespace, request.kinds, COMPARE_LIMIT),
    withSecrets
      ? api.compare.secretNamespaces(request.left, request.right).then(
          (secrets) => ({ secrets, error: null }),
          (err: unknown) => ({ secrets: null, error: toApiError(err) }),
        )
      : Promise.resolve({ secrets: null, error: null }),
  ]);
  return { left, right, secrets: secrets.secrets, secretsError: secrets.error };
}

/** The Secrets whose keys or values differ, by name. */
export function differentSecrets(secrets: SecretNamespaceComparison | null): Set<string> {
  const names = new Set<string>();
  for (const s of secrets?.secrets ?? []) {
    if (s.keys.some((k) => !(k.onLeft && k.onRight && k.equal))) names.add(s.name);
  }
  return names;
}

/** Every row of the result, kind by kind in the request's order; kinds that could not be listed on a side are left out. */
export function resultRows(result: NamespaceResult, hideDefaults: boolean, ignorePaths: IgnorePathsByKind): CompareRow[] {
  const rows: CompareRow[] = [];
  const different = differentSecrets(result.secrets);
  result.left.forEach((left, i) => {
    const right = result.right[i];
    if (!right || left.error || right.error) return;
    const kind = { ...left.kind };
    rows.push(
      ...bucketize(kind, left.objects as unknown as KubeObject[], right.objects as unknown as KubeObject[], {
        hideDefaults,
        ignorePaths,
        differentSecrets: isSecretKind(kind) ? different : undefined,
      }),
    );
  });
  return rows;
}

/** Kinds that could not be listed, per side. */
export function failedKinds(result: NamespaceResult): Array<{ side: "left" | "right"; list: CompareKindList }> {
  return [
    ...result.left.filter((l) => l.error).map((list) => ({ side: "left" as const, list })),
    ...result.right.filter((l) => l.error).map((list) => ({ side: "right" as const, list })),
  ];
}

/** Kinds whose list was cut at the cap on either side. */
export function truncatedKinds(result: NamespaceResult): string[] {
  const keys = new Set<string>();
  for (const list of [...result.left, ...result.right]) if (list.truncated) keys.add(kindKey(list.kind));
  return [...keys];
}
