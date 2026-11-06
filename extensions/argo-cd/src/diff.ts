// The "Diff" window of an Application: desired ↔ live of its resources from Argo CD's API, through Sextant
// (`sextant.service.request`, ADR-0158). Sextant keeps the session; the extension first signs in by itself with the
// admin password of `argocd-initial-admin-secret` (put in by Sextant, never seen here), and otherwise shows its
// sign-in form (a local user and password, kept by nobody: the session lasts until Sextant is closed).
import { isSextantError, type ClusterId, type ObjectRef, type Sextant, type ServiceAnswer } from "@sextant/extension-sdk";
import { describe, diffRows, isSecret, sideBySide, sidesOf, yamlOf, type ArgoResource, type DiffRow, parseManagedResources } from "./diffModel";
import { button, element, errorText } from "./dom";
import { t } from "./i18n";
import { installationPicker } from "./picker";
import {
  ADMIN_SECRET_NAMESPACES,
  SERVER_NAME,
  adminSignIn,
  answerKind,
  answerMessage,
  describeServer,
  findInstallation,
  managedResourcesRequest,
  serviceOf,
  typedSignIn,
  userInfo,
  userOf,
  type ArgoServer,
} from "./server";

/** How the session was made, kept so the session bar can say it (the token itself stays in Sextant). */
export type SessionSource = "secret" | "manual";
export const sessionKey = (clusterId: ClusterId, namespace: string): string => `session/${clusterId}/${namespace}`;

/** Why the sign-in form is shown, as notes above it. */
export interface SignInReasons {
  expired?: boolean;
  adminRefused?: boolean;
  secretDenied?: boolean;
}

/** The notes of the sign-in form, as text keys. */
export function signInNotes(server: ArgoServer, reasons: SignInReasons): string[] {
  const notes: string[] = [];
  if (reasons.expired) notes.push("login.expired");
  if (reasons.adminRefused) notes.push("login.refused.adminSecret");
  if (reasons.secretDenied) notes.push("login.secretDenied");
  if (server.insecure) notes.push("login.insecure");
  if (!server.options.localUsers) notes.push("login.noLocalUsersExtension");
  if (server.options.sso) notes.push("login.sso");
  notes.push("login.typed");
  return notes;
}

/** What a failed answer or call to Argo CD says, as a text key and Argo CD's own sentence. */
export function failureOf(answer: ServiceAnswer | null, err?: unknown): { key: string; detail: string | null } {
  if (answer) {
    const detail = answerMessage(answer);
    switch (answerKind(answer.status)) {
      case "forbidden":
        return { key: "diff.errors.forbidden", detail };
      case "unreachable":
        return { key: "login.errors.unreachable", detail };
      default:
        return { key: "login.errors.other", detail };
    }
  }
  if (isSextantError(err, "unreachable") || isSextantError(err, "timeout")) return { key: "login.errors.unreachable", detail: errorText(err) };
  return { key: "login.errors.other", detail: errorText(err) };
}

export function startDiff(sextant: Sextant, root: HTMLElement, app: ObjectRef): () => void {
  const clusterId = sextant.context.clusterId;
  let closed = false;
  let request = 0;
  /** A diff was read in this window: a later 401 means the session expired. */
  let hadSession = false;
  /** The automatic sign-in is tried once per window. */
  let autoTried = false;
  const show = (...nodes: (Node | null)[]) => {
    if (!closed) root.replaceChildren(...nodes.filter((n): n is Node => n !== null));
  };
  const title = element("h3", { textContent: t("diff.title", { name: app.name }) });

  const fail = (failure: { key: string; detail: string | null }) => {
    const box = element(
      "div",
      { className: "diff-error" },
      element("p", { textContent: t(failure.key) }),
      failure.detail ? element("p", { className: "muted", textContent: failure.detail }) : null,
      button(t("diff.retry"), () => void load()),
    );
    box.setAttribute("role", "alert");
    show(title, box);
  };

  const load = async (): Promise<void> => {
    const id = ++request;
    const current = () => !closed && id === request;
    show(title, element("p", { className: "muted", textContent: t("diff.loading") }));
    if (!clusterId) return;
    try {
      const lookup = await findInstallation(sextant, clusterId);
      if (!current()) return;
      if (lookup.type === "none") return fail({ key: "diff.errors.notFound", detail: null });
      if (lookup.type === "several") return show(title, installationPicker(sextant, clusterId, lookup.namespaces, () => void load()));
      if (lookup.server.metadata.name !== SERVER_NAME) {
        return fail({ key: "diff.errors.otherName", detail: t("diff.errors.otherNameDetail", { name: lookup.server.metadata.name }) });
      }
      const server = await describeServer(sextant, clusterId, lookup.namespace, lookup.server);
      if (!current()) return;
      await readDiff(server, current);
    } catch (err) {
      if (current()) fail(failureOf(null, err));
    }
  };

  /** Reads the diff with Sextant's session; signs in when there is none. */
  const readDiff = async (server: ArgoServer, current: () => boolean): Promise<void> => {
    let answer: ServiceAnswer;
    try {
      answer = await sextant.service.request(managedResourcesRequest(server, app));
    } catch (err) {
      // No session yet: Sextant refuses `auth: "session"` before sending anything.
      if (isSextantError(err, "unauthorized")) return signIn(server, current, {});
      throw err;
    }
    if (!current()) return;
    const kind = answerKind(answer.status);
    if (kind === "unauthorized") return signIn(server, current, { expired: hadSession });
    if (kind !== "ok") return fail(failureOf(answer));
    hadSession = true;
    const items = parseManagedResources(answer.body);
    const bar = await sessionBar(server);
    if (current()) show(title, bar, diffView(items));
  };

  const signIn = async (server: ArgoServer, current: () => boolean, reasons: SignInReasons): Promise<void> => {
    if (!autoTried && server.options.admin) {
      autoTried = true;
      if (!ADMIN_SECRET_NAMESPACES.includes(server.namespace)) {
        reasons = { ...reasons, secretDenied: true };
      } else {
        try {
          const answer = await sextant.service.request(adminSignIn(server));
          if (!current()) return;
          const kind = answerKind(answer.status);
          if (kind === "ok") {
            await sextant.storage.set(sessionKey(server.clusterId, server.namespace), "secret").catch(() => undefined);
            return readDiff(server, current);
          }
          if (kind === "unauthorized" || kind === "forbidden") reasons = { ...reasons, adminRefused: true };
          else return fail(failureOf(answer));
        } catch (err) {
          if (!current()) return;
          // `notFound`: no such Secret or key (the admin password was changed and the Secret deleted).
          if (isSextantError(err, "denied")) reasons = { ...reasons, secretDenied: true };
          else if (!isSextantError(err, "notFound")) return fail(failureOf(null, err));
        }
      }
    }
    show(title, signInForm(server, reasons));
  };

  const signInForm = (server: ArgoServer, reasons: SignInReasons): HTMLElement => {
    const username = element("input", { type: "text", value: "admin", spellcheck: false, autocomplete: "off", id: "username" });
    const password = element("input", { type: "password", autocomplete: "off", id: "password" });
    const submit = element("button", { type: "submit", className: "primary", textContent: t("login.submit") });
    const slot = element("div");
    const ready = () => username.value.trim() !== "" && password.value !== "";
    const update = () => (submit.disabled = !ready());
    username.addEventListener("input", update);
    password.addEventListener("input", update);
    update();
    const form = element(
      "form",
      { className: "login" },
      element("h4", { textContent: t("login.title") }),
      element("p", { textContent: t("login.introPassword", { namespace: server.namespace }) }),
      ...signInNotes(server, reasons).map((key) => {
        const note = element("p", { className: "note", textContent: t(key) });
        note.setAttribute("role", "note");
        return note;
      }),
      element(
        "div",
        { className: "login-fields" },
        element("label", { htmlFor: "username", textContent: t("login.username") }),
        username,
        element("label", { htmlFor: "password", textContent: t("login.password") }),
        password,
      ),
      element("p", { className: "muted hint", textContent: t("login.hintExtension") }),
      slot,
      element("div", { className: "buttons" }, submit),
    );
    form.setAttribute("aria-label", t("login.title"));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!ready() || submit.disabled) return;
      submit.disabled = true;
      submit.textContent = t("login.signingIn");
      slot.replaceChildren();
      const id = request;
      const current = () => !closed && id === request;
      try {
        const answer = await sextant.service.request(typedSignIn(server, username.value.trim(), password.value));
        if (!current()) return;
        const kind = answerKind(answer.status);
        if (kind === "ok") {
          password.value = "";
          await sextant.storage.set(sessionKey(server.clusterId, server.namespace), "manual").catch(() => undefined);
          await readDiff(server, current);
          return;
        }
        const detail = kind === "unauthorized" || kind === "forbidden" ? null : answerMessage(answer);
        const key = kind === "unauthorized" || kind === "forbidden" ? "login.errors.invalid" : kind === "unreachable" ? "login.errors.unreachable" : "login.errors.other";
        slot.replaceChildren(loginError(key, detail));
      } catch (err) {
        const failure = failureOf(null, err);
        slot.replaceChildren(loginError(failure.key, failure.detail));
      } finally {
        submit.disabled = !ready();
        submit.textContent = t("login.submit");
      }
    });
    queueMicrotask(() => password.focus());
    return form;
  };

  const sessionBar = async (server: ArgoServer): Promise<HTMLElement> => {
    let user: string | null = null;
    try {
      const answer = await sextant.service.request(userInfo(server));
      if (answerKind(answer.status) === "ok") user = userOf(answer.body);
    } catch {
      // Who is signed in is only shown; the diff is there anyway.
    }
    const source = await sextant.storage.get(sessionKey(server.clusterId, server.namespace)).catch(() => null);
    const who = user ? t("diff.signedInAs", { user }) : t("diff.signedIn");
    const how = source === "secret" || source === "manual" ? t(`diff.source.${source}`) : "";
    const signOut = async () => {
      ++request;
      await sextant.service
        .forget({ clusterId: server.clusterId, namespace: server.namespace, service: serviceOf(server) })
        .catch(() => undefined);
      await sextant.storage.remove(sessionKey(server.clusterId, server.namespace)).catch(() => undefined);
      hadSession = false;
      autoTried = true;
      show(title, signInForm(server, {}));
    };
    return element(
      "div",
      { className: "session" },
      element("span", { textContent: how ? `${who} · ${how}` : who }),
      element("span", { className: "buttons" }, button(t("diff.reload"), () => void load()), button(t("diff.signOut"), () => void signOut())),
    );
  };

  void load();
  return () => {
    closed = true;
  };
}

function loginError(key: string, detail: string | null): HTMLElement {
  const box = element("div", { className: "login-error" }, element("p", { textContent: t(key) }), detail ? element("p", { className: "muted", textContent: detail }) : null);
  box.setAttribute("role", "alert");
  return box;
}

/** The resources on the left, the selected one's desired ↔ live on the right. */
export function diffView(items: readonly ArgoResource[]): HTMLElement {
  const rows = diffRows(items);
  if (rows.length === 0) return element("p", { className: "muted", textContent: t("diff.empty") });
  const changed = rows.filter((r) => r.state !== "inSync").length;
  const view = element("div", { className: "diff-view" });
  const list = element("ul");
  list.setAttribute("aria-label", t("diff.resources"));
  const buttons: HTMLButtonElement[] = [];
  const select = (index: number) => {
    buttons.forEach((b, i) => (i === index ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current")));
    view.replaceChildren(resourceDiff(rows[index]!.resource));
  };
  rows.forEach((row, index) => {
    const item = element(
      "button",
      { type: "button", className: `diff-item ${row.state}` },
      element("span", { className: "diff-name", textContent: row.key }),
      element("span", { className: "diff-state", textContent: t(`diff.state.${row.state}`) }),
    );
    item.addEventListener("click", () => select(index));
    buttons.push(item);
    list.append(element("li", {}, item));
  });
  select(0);
  return element(
    "div",
    { className: "diff" },
    element("div", { className: "diff-list" }, element("p", { className: "muted", textContent: t("diff.summary", { count: changed, changed, total: rows.length }) }), list),
    view,
  );
}

/** One resource's two sides, line by line, unchanged runs folded behind a button. */
export function resourceDiff(resource: ArgoResource): HTMLElement {
  const key = describe(resource);
  const { desired, live } = sidesOf(resource);
  const notes = [
    isSecret(resource) ? t("diff.secretHidden") : null,
    desired === null ? t("diff.state.missingTarget") : null,
    live === null ? t("diff.state.missingLive") : null,
  ].filter((n): n is string => n !== null);
  const desiredHead = element("th", { colSpan: 2, textContent: t("diff.desired") });
  desiredHead.setAttribute("aria-label", t("diff.desiredLabel", { resource: key }));
  const liveHead = element("th", { colSpan: 2, textContent: t("diff.live") });
  liveHead.setAttribute("aria-label", t("diff.liveLabel", { resource: key }));
  const body = element("tbody");
  const addRows = (rows: readonly DiffRow[], before: Node | null = null) => {
    for (const row of rows) body.insertBefore(rowNode(row, addRows), before);
  };
  addRows(sideBySide(yamlOf(desired), yamlOf(live)));
  return element(
    "div",
    { className: "diff-resource" },
    ...notes.map((note) => element("p", { className: "note", textContent: note })),
    element("table", { className: "lines" }, element("thead", {}, element("tr", {}, desiredHead, liveHead)), body),
  );
}

function rowNode(row: DiffRow, addRows: (rows: readonly DiffRow[], before: Node | null) => void): HTMLTableRowElement {
  if (row.type === "fold") {
    const expand = button(t("diff.folded", { count: row.count }), () => {
      addRows(row.rows, tr);
      tr.remove();
    }, "link");
    const tr = element("tr", { className: "fold" }, element("td", { colSpan: 4 }, expand));
    return tr;
  }
  const side = (line: { no: number; text: string } | null, change: string) => [
    element("td", { className: "no", textContent: line ? String(line.no) : "" }),
    element("td", { className: `code${row.changed ? ` ${line ? change : "empty"}` : ""}`, textContent: line?.text ?? "" }),
  ];
  return element("tr", {}, ...side(row.left, "removed"), ...side(row.right, "added"));
}
