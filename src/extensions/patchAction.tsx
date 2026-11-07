// An extension's action that is a fixed patch (`contributes.actions[].patch`, #367): Sextant sends it itself, without
// the extension's window — no extension code runs. The patch comes from the manifest Rust checked when it read it
// (`check_action_patch`: `{{now}}` only as a whole string value); it goes to every object of the action through
// `resources.patchMany` in the extension's name, so Rust decides it against the user's grant, asks where a rule says
// `confirm`, and journals it, as for a patch the extension's frame sends. `ask` is Sextant's question before it;
// `done` what Sextant says after.
import type { ActionAsk, ActionContribution, ObjectRef } from "../api";
import { api, toApiError } from "../api";
import { ConfirmDialog } from "../components";
import { showToast } from "../features/copy-name/toast";
import type { ActionContext } from "../features/actions/registry";
import { i18n } from "../i18n";

/** Objects one `resources.patchMany` takes (Rust's `MAX_PATCH_MANY`); more go in further calls, each decided. */
export const MAX_BATCH = 50;

/** The patch with every `{{now}}` value replaced by `now` (RFC 3339, as `kubectl annotate` and Flux's CLI write it). */
export function fillPatch(patch: unknown, now: Date): unknown {
  if (patch === "{{now}}") return now.toISOString();
  if (Array.isArray(patch)) return patch.map((item) => fillPatch(item, now));
  if (patch !== null && typeof patch === "object") {
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, fillPatch(value, now)]));
  }
  return patch;
}

interface PatchManyAnswer {
  items: ({ object: unknown } | { error: { code: string; message: string } })[];
  sent: number;
}

/**
 * Sends the action's patch to `refs` in batches, each once and in order; the first failure stops the rest. Throws
 * the call's error (a refusal, the user declining); a failed object comes back as `{ref, message}`.
 */
export async function sendPatchAction(
  extensionId: string,
  action: Pick<ActionContribution, "patch">,
  clusterId: string,
  refs: readonly ObjectRef[],
  now = () => new Date(),
): Promise<{ ref: ObjectRef; message: string } | null> {
  for (let start = 0; start < refs.length; start += MAX_BATCH) {
    const batch = refs.slice(start, start + MAX_BATCH);
    const at = now();
    const answer = (await api.extensions.call(extensionId, "resources.patchMany", {
      clusterId,
      items: batch.map((ref) => ({ ref, patch: fillPatch(action.patch, at), patchType: "merge" })),
    })) as PatchManyAnswer;
    const failed = answer.items.findIndex((item) => "error" in item);
    const item = answer.items[failed];
    if (item && "error" in item) return { ref: batch[failed]!, message: item.error.message };
  }
  return null;
}

/** Runs the action on the objects of `ctx`: Sextant's question first when it has one, then the patch, then a notice. */
export function runPatchAction(
  extensionId: string,
  action: ActionContribution,
  ctx: Pick<ActionContext, "clusterId" | "refs" | "openDialog">,
): void {
  const send = async () => {
    const t = i18n.t.bind(i18n);
    try {
      const failed = await sendPatchAction(extensionId, action, ctx.clusterId, ctx.refs);
      if (failed) {
        showToast(
          t("extensions:host.action.stoppedAt", {
            action: action.title,
            kind: failed.ref.kind.kind,
            name: failed.ref.name,
            message: failed.message,
          }),
          "error",
        );
      } else if (action.done !== undefined) {
        showToast(action.done);
      }
    } catch (err) {
      const error = toApiError(err);
      // The user said no in Sextant's own confirmation: nothing to tell.
      if (error.code === "denied" && /declined|refused by the user/i.test(error.message)) return;
      showToast(t("extensions:host.action.failed", { action: action.title, message: error.message }), "error");
    }
  };
  const ask = action.ask === undefined ? undefined : fillAsk(action.ask, ctx.refs);
  if (ask === undefined) {
    void send();
    return;
  }
  ctx.openDialog((close) => (
    <ConfirmDialog
      open
      title={ask.title}
      confirmLabel={ask.confirm}
      danger={action.danger}
      onCancel={close}
      onConfirm={() => {
        close();
        void send();
      }}
    >
      <p>{ask.text}</p>
      <ul className="ext-action__objects" aria-label={i18n.t("extensions:host.action.objects")}>
        {ctx.refs.map((ref) => (
          <li key={`${ref.namespace ?? ""}/${ref.name}`}>{objectName(ref)}</li>
        ))}
      </ul>
    </ConfirmDialog>
  ));
}

/**
 * The question with what Sextant fills in it (#378): `{{count}}`, and the first object's `{{kind}}`, `{{namespace}}`
 * and `{{name}}` (Rust allows those only on an action of one object). Anything else stays as written.
 */
export function fillAsk(ask: ActionAsk, refs: readonly ObjectRef[]): ActionAsk {
  const first = refs[0];
  const values: Record<string, string> = {
    count: String(refs.length),
    kind: first?.kind.kind ?? "",
    namespace: first?.namespace ?? "",
    name: first?.name ?? "",
  };
  const fill = (text: string) =>
    text.replace(/\{\{\s*(count|kind|namespace|name)\s*\}\}/g, (_, key: string) => values[key] ?? "");
  return { title: fill(ask.title), text: fill(ask.text), confirm: fill(ask.confirm) };
}

/** `Kind namespace/name`, as the confirmation lists an object. */
function objectName(ref: ObjectRef): string {
  return `${ref.kind.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
}
