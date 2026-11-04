// The "Ceph commands" tab of a CephCluster: ceph commands of the manifest run in Rook's toolbox of the cluster's
// namespace (commands.ts). Looking runs at a click; the cluster-wide OSD flags are read from the OSD map and set or
// unset one at a time, and crash reports archived — each change confirmed by Sextant with the words it runs. The
// toolbox itself (deploy, image) is the status section's (status.ts `toolboxView`), shown here too.
import type { Sextant } from "@sextant/extension-sdk";
import { FLAGS, flagsOf, outputOf, READ_COMMANDS, run, type CommandId, type Flag, type Outcome } from "./commands";
import { badge, element, errorBox, errorText, richText } from "./dom";
import { t } from "./i18n";
import type { CephCluster } from "./rook";
import { toolboxView } from "./status";
import { changeButton } from "./ui";

/** The words a command runs, as the manifest has them (for the output's caption only; Sextant runs its own copy). */
const WORDS: Record<CommandId, string> = {
  status: "ceph status",
  "health-detail": "ceph health detail",
  "osd-tree": "ceph osd tree",
  "osd-df": "ceph osd df tree",
  df: "ceph df",
  "pg-stat": "ceph pg stat",
  versions: "ceph versions",
  "crash-ls-new": "ceph crash ls-new",
  "osd-dump": "ceph osd dump --format json",
  "osd-ok-to-stop": "ceph osd ok-to-stop",
  "osd-safe-to-destroy": "ceph osd safe-to-destroy",
  "osd-out": "ceph osd out",
  "osd-in": "ceph osd in",
  "osd-reweight": "ceph osd reweight",
  "osd-set": "ceph osd set",
  "osd-unset": "ceph osd unset",
  "crash-archive-all": "ceph crash archive-all",
};

/** The words of `id` with its values, as shown in a caption. */
export function wordsOf(id: CommandId, values: readonly string[] = []): string {
  return [WORDS[id], ...values].join(" ");
}

/** An outcome drawn: the words and how it ended, then what it printed. */
export function outcomeView(words: string, outcome: Outcome): HTMLElement {
  if (outcome.kind === "noToolbox") return element("p", { className: "warning-text" }, ...richText(t("commands.noToolbox")));
  if (outcome.kind === "failed") return element("p", { className: "error", textContent: errorText(outcome.error) });
  const { result } = outcome;
  const ending = result.timedOut
    ? badge(t("commands.timedOut"), "error")
    : result.exitCode === 0
      ? badge(t("commands.exitOk"), "ok")
      : badge(t("commands.exitCode", { code: result.exitCode ?? "?" }), "error");
  const text = outputOf(result);
  return element(
    "figure",
    { className: "command-output" },
    element("figcaption", {}, element("code", { textContent: words }), " ", ending, " ", element("span", { className: "muted", textContent: t("commands.ranIn", { pod: result.pod }) })),
    element("pre", { textContent: text === "" ? t("commands.noOutput") : text }),
    result.truncated ? element("p", { className: "muted", textContent: t("commands.truncated") }) : null,
  );
}

function lookSection(sextant: Sextant, namespace: string): HTMLElement {
  const output = element("div", {});
  output.setAttribute("aria-live", "polite");
  const buttons = READ_COMMANDS.map((id) => {
    const button = element("button", { type: "button", textContent: t(`commands.read.${id}`) });
    button.addEventListener("click", async () => {
      for (const b of buttons) b.disabled = true;
      output.replaceChildren(element("p", { className: "muted", textContent: t("commands.running", { words: wordsOf(id) }) }));
      const outcome = await run(sextant, namespace, id);
      output.replaceChildren(outcomeView(wordsOf(id), outcome));
      for (const b of buttons) b.disabled = false;
    });
    return button;
  });
  return element(
    "section",
    {},
    element("h3", { textContent: t("commands.lookTitle") }),
    element("p", { className: "muted" }, ...richText(t("commands.lookIntro"))),
    element("div", { className: "button-row" }, ...buttons),
    output,
  );
}

/** Runs a changing command; Sextant asks first. A non-zero exit is a failure with Ceph's own words. */
async function change(sextant: Sextant, namespace: string, id: CommandId, params?: Record<string, string>): Promise<void> {
  const outcome = await run(sextant, namespace, id, params);
  if (outcome.kind === "noToolbox") throw new Error(t("commands.noToolboxShort"));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.result.timedOut) throw new Error(t("commands.timedOut"));
  if (outcome.result.exitCode !== 0) throw new Error(outputOf(outcome.result) || t("commands.exitCode", { code: outcome.result.exitCode ?? "?" }));
}

function flagsSection(sextant: Sextant, namespace: string): HTMLElement {
  const body = element("div", {});
  const refresh = element("button", { type: "button", textContent: t("commands.flagsRead") });
  const read = async () => {
    refresh.disabled = true;
    body.replaceChildren(element("p", { className: "muted", textContent: t("common.loading") }));
    const outcome = await run(sextant, namespace, "osd-dump");
    refresh.disabled = false;
    // Without a toolbox (or on a refusal) there is nothing to set flags with: only why.
    if (outcome.kind !== "ran") {
      body.replaceChildren(outcomeView(wordsOf("osd-dump"), outcome));
      return;
    }
    // The map not read (cut, not JSON): each flag is unknown and offers both buttons.
    const flags = flagsOf(outcome.result);
    body.replaceChildren(
      ...(flags === null ? [element("p", { className: "warning-text", textContent: t("commands.flagsUnknown") })] : []),
      ...FLAGS.map((flag) => flagRow(sextant, namespace, flag, flags, () => void read())),
    );
  };
  refresh.addEventListener("click", () => void read());
  void read();
  return element(
    "section",
    {},
    element("h3", { textContent: t("commands.flagsTitle") }),
    element("p", { className: "muted" }, ...richText(t("commands.flagsIntro"))),
    element("p", {}, refresh),
    body,
  );
}

function flagRow(sextant: Sextant, namespace: string, flag: Flag, flags: Set<string> | null, reread: () => void): HTMLElement {
  const isSet = flags?.has(flag) ?? null;
  const state =
    isSet === null ? badge(t("commands.flagUnknown"), "neutral") : isSet ? badge(t("commands.flagSet"), "warning") : badge(t("commands.flagNotSet"), "ok");
  const controls: HTMLElement[] = [];
  const add = (id: "osd-set" | "osd-unset") => {
    const label = t(id === "osd-set" ? "commands.flagDoSet" : "commands.flagDoUnset");
    const { button, status } = changeButton(label, () => change(sextant, namespace, id, { flag }), { done: reread });
    button.setAttribute("aria-label", `${label} ${flag}`);
    controls.push(button, status);
  };
  if (isSet !== true) add("osd-set");
  if (isSet !== false) add("osd-unset");
  return element(
    "div",
    { className: "flag-row" },
    element("code", { textContent: flag }),
    " ",
    state,
    element("span", { className: "muted", textContent: ` ${t(`commands.flag.${flag}`)} ` }),
    element("span", { className: "inline-change" }, ...controls),
  );
}

function crashSection(sextant: Sextant, namespace: string): HTMLElement {
  const archive = changeButton(t("commands.crashArchive"), () => change(sextant, namespace, "crash-archive-all"));
  return element(
    "section",
    {},
    element("h3", { textContent: t("commands.crashTitle") }),
    element("p", { className: "muted" }, ...richText(t("commands.crashIntro"))),
    element("p", {}, archive.button, archive.status),
  );
}

export function startCommands(sextant: Sextant, root: HTMLElement): () => void {
  const ref = sextant.context.selection[0];
  const namespace = ref?.namespace;
  if (!ref || !namespace) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.noCluster") }));
    return () => undefined;
  }
  const toolbox = element("section", {}, element("h3", { textContent: t("status.toolboxTitle") }), element("p", { className: "muted", textContent: t("common.loading") }));
  root.replaceChildren(
    element("div", { className: "commands" }, toolbox, lookSection(sextant, namespace), flagsSection(sextant, namespace), crashSection(sextant, namespace)),
  );
  void sextant.resources
    .get({ ref })
    .then((cluster) => toolboxView(sextant, namespace, cluster as CephCluster))
    .then((view) => toolbox.replaceChildren(element("h3", { textContent: t("status.toolboxTitle") }), view))
    .catch((err: unknown) => toolbox.replaceChildren(element("h3", { textContent: t("status.toolboxTitle") }), errorBox(err)));
  return () => undefined;
}
