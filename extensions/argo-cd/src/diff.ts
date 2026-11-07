// The "Diff" window of an Application: desired ↔ live of its resources from Argo CD's API, through Sextant
// (`sextant.service.request`, ADR-0158). Sextant keeps the session and every secret: before asking, the extension
// signs in with the login typed earlier in Sextant's dialog or remembered there for the cluster (a user and password,
// or an API token), then with the admin password of `argocd-initial-admin-secret`, then with the API token of each
// Secret labelled `app.kubernetes.io/part-of=argocd` (by name) — the order of Sextant's former built-in view, each put
// in by Sextant, never seen here — and otherwise asks the user to sign in in Sextant's own dialog (`ui.signIn`,
// ADR-0160). Credentials Argo CD refused are not sent again in this run (Sextant answers `notSent`), so a changed admin
// password is not tried from every window.
import { isSextantError, ui, type ClusterId, type ObjectRef, type Sextant, type ServiceAnswer, type SignInState } from "@sextant/extension-sdk";
import { describe, diffRows, isSecret, sideBySide, sidesOf, yamlOf, type ArgoResource, type DiffRow, parseManagedResources } from "./diffModel";
import { buttons, element, errorText } from "./dom";
import { t } from "./i18n";
import { installationPicker } from "./picker";
import {
  adminSignIn,
  answerKind,
  answerMessage,
  describeServer,
  findInstallation,
  isRefused,
  managedResourcesRequest,
  serviceOf,
  tokenSecrets,
  typedSignIn,
  userInfo,
  userOf,
  type ArgoServer,
  type SignInMode,
  type Using,
} from "./server";

/** How the session was made, kept so the session bar can say it (the token itself stays in Sextant). */
export type SessionSource = "secret" | "signIn";
export const sessionKey = (clusterId: ClusterId, namespace: string): string => `session/${clusterId}/${namespace}`;
/** The API token Secret that signed in last (its name only), tried first by a later window. */
export const tokenSecretKey = (clusterId: ClusterId, namespace: string): string => `tokenSecret/${clusterId}/${namespace}`;

/**
 * How the window is signed in, as the session bar says it (the built-in view's `diff.source.*`): the standard admin
 * Secret, an API token Secret by name, or the user's own sign-in in Sextant's dialog — saved for the cluster, typed for
 * this run only (`service.signInState`), or "your sign-in" when Sextant could not tell.
 */
export function sourceText(using: Using, stored: unknown, state: SignInState | null = null): string {
  if (typeof using !== "string") return t("diff.source.tokenSecret", { name: using.secret });
  if (using === "password" && stored === "secret") return t("diff.source.secret");
  if (state === "saved") return t("diff.source.saved");
  if (state === "session") return t("diff.source.session");
  return t("diff.source.signIn");
}

/** Whether the sign-in of `using`'s service is saved or typed for this run; `null` when Sextant does not say. */
export async function signInStateOf(sextant: Sextant, server: ArgoServer, using: Using): Promise<SignInState | null> {
  if (typeof using !== "string") return null;
  try {
    return await sextant.service.signInState({ clusterId: server.clusterId, namespace: server.namespace, service: serviceOf(server, using) });
  } catch {
    // Only shown: the bar keeps "with your sign-in".
    return null;
  }
}

/** The token Secrets in the order they are tried: the one that signed in last, then the others by name. */
export function tokenOrder(names: readonly string[], last: unknown): string[] {
  return typeof last === "string" && names.includes(last) ? [last, ...names.filter((n) => n !== last)] : [...names];
}

/** Why the sign-in is asked for, as notes above it. */
export interface SignInReasons {
  expired?: boolean;
  /** Argo CD refused the login typed or remembered earlier. */
  savedRefused?: boolean;
  adminRefused?: boolean;
  /** Argo CD refused the API token of every Secret labelled `app.kubernetes.io/part-of=argocd`. */
  tokenRefused?: boolean;
}

/** The notes above the sign-in, as text keys. */
export function signInNotes(server: ArgoServer, reasons: SignInReasons): string[] {
  const notes: string[] = [];
  if (reasons.expired) notes.push("login.expired");
  if (reasons.savedRefused) notes.push("login.refused.saved");
  if (reasons.adminRefused) notes.push("login.refused.adminSecret");
  if (reasons.tokenRefused) notes.push("login.refused.tokenSecret");
  if (server.insecure) notes.push("login.insecure");
  if (!server.options.localUsers) notes.push("login.noLocalUsers");
  if (server.options.sso) notes.push("login.sso");
  return notes;
}

/** What a failed answer or call to Argo CD says, as a text key and Argo CD's own sentence. */
export function failureOf(answer: ServiceAnswer | null, err?: unknown): Failure {
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

export interface Failure {
  key: string;
  detail: string | null;
}

/** How a sign-in with a user and password went: `none` when nothing was typed or remembered for it. */
export type Outcome = "ok" | "none" | "refused" | Failure;

/** Signs in with the user and password Sextant has for the service (typed this run, or remembered). */
export async function passwordSignIn(sextant: Sextant, server: ArgoServer): Promise<Outcome> {
  let answer: ServiceAnswer;
  try {
    answer = await sextant.service.request(typedSignIn(server));
  } catch (err) {
    // Nothing typed or remembered: Sextant refuses before sending anything.
    if (isSextantError(err, "unauthorized")) return "none";
    return failureOf(null, err);
  }
  if (answerKind(answer.status) === "ok") return "ok";
  if (isRefused(answer)) return "refused";
  return failureOf(answer);
}

/** Drops the sessions and the sign-ins (also the remembered ones) of both ways of signing in. */
export async function signOut(sextant: Sextant, server: ArgoServer): Promise<void> {
  for (const mode of ["password", "token"] as const) {
    await sextant.service.forget({ clusterId: server.clusterId, namespace: server.namespace, service: serviceOf(server, mode) }).catch(() => undefined);
  }
  await sextant.storage.remove(sessionKey(server.clusterId, server.namespace)).catch(() => undefined);
  await sextant.storage.remove(tokenSecretKey(server.clusterId, server.namespace)).catch(() => undefined);
}

export function startDiff(sextant: Sextant, root: HTMLElement, app: ObjectRef): () => void {
  const clusterId = sextant.context.clusterId;
  let closed = false;
  let request = 0;
  /** A diff was read in this window: a later 401 means the session expired. */
  let hadSession = false;
  /** The way of signing in that worked in this window; a session first otherwise. */
  let mode: Using | null = null;
  /** What is tried by itself, each once per window (and none after signing out). */
  const tried = { password: false, token: false, admin: false, tokenSecrets: false };
  const show = (...nodes: (Node | null)[]) => {
    if (!closed) root.replaceChildren(...nodes.filter((n): n is Node => n !== null));
  };
  const title = element("h3", { textContent: t("diff.title", { name: app.name }) });

  const fail = (failure: Failure) => {
    const box = element(
      "div",
      { className: "diff-error" },
      element("p", { textContent: t(failure.key) }),
      failure.detail ? element("p", {}, ui.muted(failure.detail)) : null,
      ui.button(t("diff.retry"), () => void load()),
    );
    box.setAttribute("role", "alert");
    show(title, box);
  };

  const load = async (): Promise<void> => {
    const id = ++request;
    const current = () => !closed && id === request;
    show(title, ui.loading(t("diff.loading")));
    if (!clusterId) return;
    try {
      const lookup = await findInstallation(sextant, clusterId);
      if (!current()) return;
      if (lookup.type === "none") return fail({ key: "diff.errors.notFound", detail: null });
      if (lookup.type === "several") return show(title, installationPicker(sextant, clusterId, lookup.namespaces, () => void load()));
      const server = await describeServer(sextant, clusterId, lookup.namespace, lookup.server);
      if (!current()) return;
      await readDiff(server, current, {});
    } catch (err) {
      if (current()) fail(failureOf(null, err));
    }
  };

  /** Reads the diff with Sextant's session (or the API token); signs in when there is none. */
  const readDiff = async (server: ArgoServer, current: () => boolean, reasons: SignInReasons): Promise<void> => {
    const using = mode ?? "password";
    let answer: ServiceAnswer;
    try {
      answer = await sextant.service.request(managedResourcesRequest(server, app, using));
    } catch (err) {
      // No session (or no token) yet: Sextant refuses before sending anything.
      if (!isSextantError(err, "unauthorized")) throw err;
      mode = null;
      return signIn(server, current, reasons);
    }
    if (!current()) return;
    const kind = answerKind(answer.status);
    if (kind === "unauthorized") {
      mode = null;
      if (typeof using !== "string") return signIn(server, current, { ...reasons, tokenRefused: true });
      if (using === "token") return signIn(server, current, { ...reasons, savedRefused: true });
      return signIn(server, current, { ...reasons, expired: hadSession });
    }
    if (kind !== "ok") return fail(failureOf(answer));
    mode = using;
    hadSession = true;
    const items = parseManagedResources(answer.body);
    const bar = await sessionBar(server, using);
    if (current()) show(title, bar, diffView(items));
  };

  /** Signs in by itself (each way once per window), else asks the user. */
  const signIn = async (server: ArgoServer, current: () => boolean, reasons: SignInReasons): Promise<void> => {
    const remember = (source: SessionSource) => sextant.storage.set(sessionKey(server.clusterId, server.namespace), source).catch(() => undefined);
    // The user and password typed earlier in Sextant's dialog, or remembered there for this cluster.
    if (!tried.password) {
      tried.password = true;
      const outcome = await passwordSignIn(sextant, server);
      if (!current()) return;
      if (outcome === "ok") {
        await remember("signIn");
        return readDiff(server, current, reasons);
      }
      if (outcome === "refused") reasons = { ...reasons, savedRefused: true };
      else if (outcome !== "none") return fail(outcome);
    }
    // The API token typed or remembered the same way: the diff is read with it directly.
    if (!tried.token) {
      tried.token = true;
      mode = "token";
      return readDiff(server, current, reasons);
    }
    // The admin password of argocd-initial-admin-secret, put in by Sextant.
    if (!tried.admin && server.options.admin) {
      tried.admin = true;
      try {
        const answer = await sextant.service.request(adminSignIn(server));
        if (!current()) return;
        if (answerKind(answer.status) === "ok") {
          await remember("secret");
          return readDiff(server, current, reasons);
        }
        // Refused now, or earlier in this run (Sextant did not send the same password again).
        if (isRefused(answer)) reasons = { ...reasons, adminRefused: true };
        else return fail(failureOf(answer));
      } catch (err) {
        if (!current()) return;
        // `notFound`: no such Secret or key (the admin password was changed and the Secret deleted).
        if (!isSextantError(err, "notFound")) return fail(failureOf(null, err));
      }
    }
    // The API token of each Secret labelled app.kubernetes.io/part-of=argocd, by name, sent by Sextant as the bearer;
    // Argo CD's `userinfo` says whether it accepts it.
    if (!tried.tokenSecrets) {
      tried.tokenSecrets = true;
      const names = await tokenSecrets(sextant, server);
      if (!current()) return;
      const last = names.length > 0 ? await sextant.storage.get(tokenSecretKey(server.clusterId, server.namespace)).catch(() => null) : null;
      let refused = false;
      for (const name of tokenOrder(names, last)) {
        const using: Using = { secret: name };
        let answer: ServiceAnswer;
        try {
          answer = await sextant.service.request(userInfo(server, using));
        } catch (err) {
          if (!current()) return;
          // The Secret or its key is gone since it was listed: the next one.
          if (isSextantError(err, "notFound")) continue;
          return fail(failureOf(null, err));
        }
        if (!current()) return;
        if (answerKind(answer.status) === "ok" && userOf(answer.body) !== null) {
          mode = using;
          await sextant.storage.set(tokenSecretKey(server.clusterId, server.namespace), name).catch(() => undefined);
          return readDiff(server, current, reasons);
        }
        // `loggedIn: false`: Argo CD does not accept the token.
        if (answerKind(answer.status) === "ok" || isRefused(answer)) refused = true;
        else return fail(failureOf(answer));
      }
      if (refused) reasons = { ...reasons, tokenRefused: true };
    }
    show(title, signInChoice(server, reasons));
  };

  /** Asks how to sign in; each way opens Sextant's own dialog for its service. */
  const signInChoice = (server: ArgoServer, reasons: SignInReasons, error: Failure | null = null): HTMLElement => {
    const preferToken = !server.options.localUsers;
    const way = (which: SignInMode) =>
      ui.button(t(`login.mode.${which}`), () => void askSignIn(server, which), {
        variant: (which === "token") === preferToken ? "primary" : "default",
      });
    const group = element("div", { className: "buttons" }, way("password"), way("token"));
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("login.mode.label"));
    const alert = error
      ? element("div", { className: "login-error" }, element("p", { textContent: t(error.key) }), error.detail ? element("p", {}, ui.muted(error.detail)) : null)
      : null;
    alert?.setAttribute("role", "alert");
    const section = element(
      "section",
      { className: "login" },
      element("h4", { textContent: t("login.title") }),
      element("p", { textContent: t("login.intro", { namespace: server.namespace }) }),
      ...signInNotes(server, reasons).map((key) => {
        const note = element("p", { className: "note", textContent: t(key) });
        note.setAttribute("role", "note");
        return note;
      }),
      alert,
      group,
      element("p", { className: "hint" }, ui.muted(t("login.hint"))),
    );
    section.setAttribute("aria-label", t("login.title"));
    return section;
  };

  /** Sextant's dialog for `which`, then a sign-in with what the user typed there. */
  const askSignIn = async (server: ArgoServer, which: SignInMode): Promise<void> => {
    const id = ++request;
    const current = () => !closed && id === request;
    const again = (error: Failure | null) => {
      if (current()) show(title, signInChoice(server, {}, error));
    };
    show(title, ui.loading(t("login.signingIn")));
    try {
      const signed = await sextant.ui.signIn({ clusterId: server.clusterId, namespace: server.namespace, service: serviceOf(server, which) });
      if (!current()) return;
      if (!signed) return again(null);
      await sextant.storage.set(sessionKey(server.clusterId, server.namespace), "signIn").catch(() => undefined);
      if (which === "password") {
        const outcome = await passwordSignIn(sextant, server);
        if (!current()) return;
        if (outcome === "ok") {
          mode = "password";
          return await readDiff(server, current, {});
        }
        return again(outcome === "refused" || outcome === "none" ? { key: "login.errors.invalid", detail: null } : outcome);
      }
      const answer = await sextant.service.request(managedResourcesRequest(server, app, "token"));
      if (!current()) return;
      if (answer.notSent === true || answerKind(answer.status) === "unauthorized") return again({ key: "login.errors.invalidToken", detail: null });
      if (answerKind(answer.status) !== "ok") return again(failureOf(answer));
      mode = "token";
      hadSession = true;
      const bar = await sessionBar(server, "token");
      if (current()) show(title, bar, diffView(parseManagedResources(answer.body)));
    } catch (err) {
      if (current()) again(failureOf(null, err));
    }
  };

  const sessionBar = async (server: ArgoServer, using: Using): Promise<HTMLElement> => {
    let user: string | null = null;
    try {
      const answer = await sextant.service.request(userInfo(server, using));
      if (answerKind(answer.status) === "ok") user = userOf(answer.body);
    } catch {
      // Who is signed in is only shown; the diff is there anyway.
    }
    const stored = using === "password" ? await sextant.storage.get(sessionKey(server.clusterId, server.namespace)).catch(() => null) : null;
    // Signed in through Sextant's dialog: whether that sign-in is saved for the cluster or kept until Sextant closes.
    const state = using === "token" || (using === "password" && stored !== "secret") ? await signInStateOf(sextant, server, using) : null;
    const who = user ? t("diff.signedInAs", { user }) : t("diff.signedIn");
    const text = `${who} · ${sourceText(using, stored, state)}`;
    const leave = async () => {
      ++request;
      await signOut(sextant, server);
      hadSession = false;
      mode = null;
      tried.password = tried.token = tried.admin = tried.tokenSecrets = true;
      show(title, signInChoice(server, {}));
    };
    return element(
      "div",
      { className: "session" },
      element("span", { textContent: text }),
      buttons(ui.button(t("diff.reload"), () => void load()), ui.button(t("diff.signOut"), () => void leave())),
    );
  };

  void load();
  return () => {
    closed = true;
  };
}

/** The resources on the left, the selected one's desired ↔ live on the right. */
export function diffView(items: readonly ArgoResource[]): HTMLElement {
  const rows = diffRows(items);
  if (rows.length === 0) return ui.empty(t("diff.empty"));
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
    element("div", { className: "diff-list" }, element("p", {}, ui.muted(t("diff.summary", { count: changed, changed, total: rows.length }))), list),
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
    const expand = ui.button(t("diff.folded", { lines: row.count }), () => {
      addRows(row.rows, tr);
      tr.remove();
    });
    expand.classList.add("link");
    const tr = element("tr", { className: "fold" }, element("td", { colSpan: 4 }, expand));
    return tr;
  }
  const side = (line: { no: number; text: string } | null, change: string) => [
    element("td", { className: "no", textContent: line ? String(line.no) : "" }),
    element("td", { className: `code${row.changed ? ` ${line ? change : "empty"}` : ""}`, textContent: line?.text ?? "" }),
  ];
  return element("tr", {}, ...side(row.left, "removed"), ...side(row.right, "added"));
}
