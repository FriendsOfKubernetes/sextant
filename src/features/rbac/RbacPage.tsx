// The "Permissions" page of the Access Control section (#140), three tabs:
//   - Subject: a user, group or service account (picked from the subjects bindings name, or typed) → its effective
//     permissions per namespace as a verbs × resources matrix, each cell naming the bindings and roles that grant it;
//   - Who can: a verb on a resource (or a non-resource URL) → the subjects allowed, through which binding and role;
//   - Can I: the API server's own answer for the current user (SelfSubjectRulesReview per namespace, and a
//     SelfSubjectAccessReview on demand) — authoritative, unlike the computed tabs.
// Roles, ClusterRoles and bindings are watched only while the page is open, namespaced ones only in the namespaces of
// the namespace filter; the reviews are sent only when the user asks.
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type AccessAnswer, type ApiError, type ClusterId, type RulesReview } from "../../api";
import { Button, Checkbox, EmptyState, ErrorState, Tabs } from "../../components";
import { formatList } from "../../i18n/format";
import { registerPage, type PageProps } from "../../layout/pages";
import { useClusterKinds } from "../../resources";
import { useSelectedNamespaces } from "../namespaces";
import {
  buildIndex,
  grantsOfReview,
  knownSubjects,
  MASTERS,
  rulesOfReview,
  permissionsOf,
  subjectKey,
  whoCan,
  type Subject,
  type SubjectKind,
  type WhoCanQuery,
} from "./engine";
import { ALL_LISTS, useRbacData, type RbacState } from "./hooks";
import { PermissionMatrix } from "./Matrix";
import { clusterScopedOf, COMMON_VERBS, resolveResource, resourceSuggestions } from "./query";
import {
  EMPTY_CAN_I,
  RBAC_PAGE,
  useRbacPageState,
  useRbacStore,
  type CanIForm,
  type RbacPageState,
  type RbacTab,
  type WhoCanForm,
} from "./state";
import {
  ComputedNote,
  entryText,
  Explanations,
  ImplicitGroups,
  ListProblems,
  RefLink,
  scopeText,
  subjectText,
  SubjectLabel,
  Warnings,
} from "./ui";

/** At most this many subjects in the picker list; the search narrows it. */
export const MAX_PICKER = 200;

const SUBJECT_KINDS: SubjectKind[] = ["User", "Group", "ServiceAccount"];

/** Namespaces the RBAC objects mention, plus the filter's, sorted. */
function namespacesOf(state: RbacState, selected: readonly string[] | null): string[] {
  const found = new Set(selected ?? []);
  for (const o of [...(state.data.roleBindings ?? []), ...(state.data.roles ?? [])]) {
    if (o.metadata?.namespace) found.add(o.metadata.namespace);
  }
  return [...found].sort();
}

// ---------- Subject ----------

function SubjectPicker({ subjects, onPick, search, onSearch }: { subjects: Subject[]; onPick: (s: Subject) => void; search: string; onSearch: (v: string) => void }) {
  const { t } = useTranslation();
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? subjects.filter((s) => `${s.kind} ${s.namespace ?? ""}/${s.name}`.toLowerCase().includes(needle))
    : subjects;
  const shown = matching.slice(0, MAX_PICKER);
  return (
    <div className="rbac-picker">
      <input
        type="search"
        className="rbac-input"
        value={search}
        placeholder={t("rbac:subject.search")}
        aria-label={t("rbac:subject.search")}
        onChange={(e) => onSearch(e.target.value)}
      />
      <p className="dt-muted">{t("rbac:subject.known", { count: subjects.length })}</p>
      {shown.length === 0 ? (
        <p className="dt-muted">{t("rbac:subject.none")}</p>
      ) : (
        <ul className="rbac-picker__list" aria-label={t("rbac:subject.listLabel")}>
          {shown.map((s) => (
            <li key={subjectKey(s)}>
              <button type="button" className="rbac-picker__item" onClick={() => onPick(s)}>
                {subjectText(t, s)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {matching.length > shown.length && (
        <p className="dt-muted">{t("rbac:subject.more", { count: matching.length - shown.length })}</p>
      )}
    </div>
  );
}

function OtherSubjectForm({ onPick }: { onPick: (s: Subject) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SubjectKind>("User");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [groups, setGroups] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (kind === "ServiceAccount" && !namespace.trim())) return;
    const subject: Subject = { kind, name: name.trim() };
    if (kind === "ServiceAccount") subject.namespace = namespace.trim();
    const list = groups.split(",").map((g) => g.trim()).filter(Boolean);
    if (kind === "User" && list.length > 0) subject.groups = list;
    onPick(subject);
  };
  return (
    <form className="rbac-form" onSubmit={submit} aria-label={t("rbac:subject.other")}>
      <label className="rbac-field">
        <span className="rbac-field__label">{t("rbac:subject.kind")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as SubjectKind)}>
          {SUBJECT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`rbac:subject.kinds.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="rbac-field">
        <span className="rbac-field__label">{t("rbac:subject.name")}</span>
        <input className="rbac-input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      {kind === "ServiceAccount" && (
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:subject.namespace")}</span>
          <input className="rbac-input" value={namespace} spellCheck={false} onChange={(e) => setNamespace(e.target.value)} />
        </label>
      )}
      {kind === "User" && (
        <label className="rbac-field rbac-field--grow">
          <span className="rbac-field__label">{t("rbac:subject.groups")}</span>
          <input className="rbac-input" value={groups} spellCheck={false} onChange={(e) => setGroups(e.target.value)} />
        </label>
      )}
      <Button type="submit" disabled={!name.trim() || (kind === "ServiceAccount" && !namespace.trim())}>
        {t("rbac:subject.show")}
      </Button>
    </form>
  );
}

function SubjectTab({ clusterId, rbac, namespaces }: { clusterId: ClusterId; rbac: RbacState; namespaces: string[] }) {
  const { t } = useTranslation();
  const page = useRbacPageState(clusterId);
  const patchPage = useRbacStore((s) => s.patch);
  const patch = (p: Partial<RbacPageState>) => patchPage(clusterId, p);
  const subjects = useMemo(() => knownSubjects(rbac.data), [rbac.data]);
  const index = useMemo(() => buildIndex(rbac.data), [rbac.data]);
  const kinds = useClusterKinds(clusterId);
  const scoped = useMemo(() => clusterScopedOf(kinds.kinds), [kinds.kinds]);
  const subject = page.subject;
  const perms = useMemo(
    () => (subject ? permissionsOf(index, subject, page.namespace, scoped) : null),
    [index, subject, page.namespace, scoped],
  );

  if (!subject) {
    return (
      <div className="rbac-tab">
        <ComputedNote />
        <ListProblems state={rbac} />
        <p>{t("rbac:subject.choose")}</p>
        <SubjectPicker subjects={subjects} search={page.search} onSearch={(search) => patch({ search })} onPick={(s) => patch({ subject: s })} />
        <h3 className="rbac-heading">{t("rbac:subject.other")}</h3>
        <p className="dt-muted">{t("rbac:notes.groups")}</p>
        <OtherSubjectForm onPick={(s) => patch({ subject: s })} />
      </div>
    );
  }

  return (
    <div className="rbac-tab">
      <div className="rbac-subject">
        <div className="rbac-subject__name">
          <SubjectLabel subject={subject} />
          {subject.groups && subject.groups.length > 0 && (
            <span className="dt-muted">{t("rbac:subject.memberOf", { groups: formatList(subject.groups) })}</span>
          )}
        </div>
        <Button onClick={() => patch({ subject: null })}>{t("rbac:subject.change")}</Button>
      </div>
      <ImplicitGroups subject={subject} />
      <label className="rbac-field">
        <span className="rbac-field__label">{t("rbac:scope.label")}</span>
        <select value={page.namespace ?? ""} onChange={(e) => patch({ namespace: e.target.value || null })}>
          <option value="">{t("rbac:scope.all")}</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </label>
      <ComputedNote />
      <ListProblems state={rbac} />
      {perms && <Warnings warnings={perms.warnings} />}
      {perms && !rbac.loading && (
        <PermissionMatrix grants={perms.grants} clusterScoped={scoped} label={t("rbac:matrix.label", { subject: subjectText(t, subject) })} />
      )}
    </div>
  );
}

// ---------- Who can ----------

function WhoCanFormView({ form, onChange, onSubmit, suggestions, namespaces }: { form: WhoCanForm; onChange: (p: Partial<WhoCanForm>) => void; onSubmit: () => void; suggestions: string[]; namespaces: string[] }) {
  const { t } = useTranslation();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const ready = form.verb.trim() && (form.mode === "url" ? form.url.trim().startsWith("/") : form.resource.trim());
  return (
    <form className="rbac-form" onSubmit={submit} aria-label={t("rbac:whoCan.formLabel")}>
      <label className="rbac-field">
        <span className="rbac-field__label">{t("rbac:whoCan.verb")}</span>
        <input className="rbac-input rbac-input--short" list="rbac-verbs" value={form.verb} spellCheck={false} onChange={(e) => onChange({ verb: e.target.value })} />
      </label>
      <label className="rbac-toggle">
        <Checkbox checked={form.mode === "url"} onChange={(e) => onChange({ mode: e.target.checked ? "url" : "resource" })} />
        {t("rbac:whoCan.urlMode")}
      </label>
      {form.mode === "url" ? (
        <label className="rbac-field rbac-field--grow">
          <span className="rbac-field__label">{t("rbac:whoCan.url")}</span>
          <input className="rbac-input" value={form.url} placeholder={t("rbac:whoCan.urlPlaceholder")} spellCheck={false} onChange={(e) => onChange({ url: e.target.value })} />
        </label>
      ) : (
        <>
          <label className="rbac-field rbac-field--grow">
            <span className="rbac-field__label">{t("rbac:whoCan.resource")}</span>
            <input
              className="rbac-input"
              list="rbac-resources"
              value={form.resource}
              placeholder={t("rbac:whoCan.resourcePlaceholder")}
              spellCheck={false}
              onChange={(e) => onChange({ resource: e.target.value })}
            />
          </label>
          <label className="rbac-field">
            <span className="rbac-field__label">{t("rbac:whoCan.subresource")}</span>
            <input className="rbac-input rbac-input--short" value={form.subresource} placeholder={t("rbac:whoCan.subresourcePlaceholder")} spellCheck={false} onChange={(e) => onChange({ subresource: e.target.value })} />
          </label>
          <label className="rbac-field">
            <span className="rbac-field__label">{t("rbac:whoCan.name")}</span>
            <input className="rbac-input rbac-input--short" value={form.name} spellCheck={false} onChange={(e) => onChange({ name: e.target.value })} />
          </label>
          <label className="rbac-field">
            <span className="rbac-field__label">{t("rbac:whoCan.namespace")}</span>
            <input
              className="rbac-input rbac-input--short"
              list="rbac-namespaces"
              value={form.namespace}
              placeholder={t("rbac:whoCan.anyNamespace")}
              spellCheck={false}
              onChange={(e) => onChange({ namespace: e.target.value })}
            />
          </label>
        </>
      )}
      <Button type="submit" variant="primary" disabled={!ready}>
        {t("rbac:whoCan.find")}
      </Button>
      <datalist id="rbac-verbs">
        {COMMON_VERBS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="rbac-resources">
        {suggestions.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="rbac-namespaces">
        {namespaces.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </form>
  );
}

function WhoCanTab({ clusterId, rbac, namespaces }: { clusterId: ClusterId; rbac: RbacState; namespaces: string[] }) {
  const { t } = useTranslation();
  const page = useRbacPageState(clusterId);
  const kinds = useClusterKinds(clusterId);
  const patch = useRbacStore((s) => s.patch);
  const suggestions = useMemo(() => resourceSuggestions(kinds.kinds), [kinds.kinds]);
  const index = useMemo(() => buildIndex(rbac.data), [rbac.data]);
  const asked = page.whoCanAsked;
  const resolved = asked && asked.mode === "resource" ? resolveResource(asked.resource, asked.subresource, kinds.kinds) : null;
  const result = useMemo(() => {
    if (!asked) return null;
    let query: WhoCanQuery | null = null;
    if (asked.mode === "url") query = { verb: asked.verb.trim(), nonResourceURL: asked.url.trim() };
    else if (resolved) {
      query = {
        verb: asked.verb.trim(),
        group: resolved.group,
        resource: resolved.resource,
        subresource: resolved.subresource,
        name: asked.name.trim() || undefined,
        namespace: asked.namespace.trim() || null,
        clusterScoped: resolved.clusterScoped,
      };
    }
    return query ? whoCan(index, query) : null;
  }, [asked, resolved?.group, resolved?.resource, resolved?.subresource, resolved?.clusterScoped, index]);

  return (
    <div className="rbac-tab">
      <WhoCanFormView
        form={page.whoCan}
        suggestions={suggestions}
        namespaces={namespaces}
        onChange={(p) => patch(clusterId, { whoCan: { ...page.whoCan, ...p } })}
        onSubmit={() => patch(clusterId, { whoCanAsked: page.whoCan })}
      />
      <ComputedNote />
      <ListProblems state={rbac} />
      {resolved && !resolved.known && kinds.kinds && (
        <p className="rbac-note rbac-note--warn">{t("rbac:whoCan.unknownResource", { resource: asked?.resource ?? "" })}</p>
      )}
      {resolved?.clusterScoped && asked?.namespace.trim() && <p className="dt-muted">{t("rbac:whoCan.clusterScoped")}</p>}
      {result && <Warnings warnings={result.warnings} />}
      {result && !rbac.loading && (
        <>
          <p role="status">{result.answers.length === 0 ? t("rbac:whoCan.none") : t("rbac:whoCan.results", { count: result.answers.length })}</p>
          <p className="dt-muted">{t("rbac:whoCan.masters", { group: MASTERS })}</p>
          {result.answers.length > 0 && (
            <div className="dt-table-wrap">
              <table className="dt-table rbac-grants" aria-label={t("rbac:whoCan.tableLabel")}>
                <thead>
                  <tr>
                    <th>{t("rbac:whoCan.subject")}</th>
                    <th>{t("rbac:grants.binding")}</th>
                    <th>{t("rbac:grants.role")}</th>
                    <th>{t("rbac:grants.scope")}</th>
                    <th>{t("rbac:grants.notes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.answers.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <button
                          type="button"
                          className="rt-link"
                          title={t("rbac:whoCan.showSubject")}
                          onClick={() => patch(clusterId, { tab: "subject", subject: a.subject, namespace: a.scope })}
                        >
                          {entryText(t, a.entry, a.scope)}
                        </button>
                      </td>
                      <td>
                        <RefLink refTo={a.binding} />
                      </td>
                      <td>
                        <RefLink refTo={a.role} />
                        {a.via && <div className="dt-muted">{t("rbac:rules.via", { source: a.via })}</div>}
                      </td>
                      <td>{scopeText(t, a.scope)}</td>
                      <td>
                        {a.onlyNames && <div className="rbac-notes__warn">{t("rbac:explain.onlyNames", { list: formatList(a.onlyNames) })}</div>}
                        <Explanations rule={a} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.truncated && <p className="dt-muted">{t("rbac:whoCan.truncated", { count: result.answers.length })}</p>}
        </>
      )}
    </div>
  );
}

// ---------- Can I ----------

type Pending<T> = { state: "idle" } | { state: "loading" } | { state: "done"; value: T } | { state: "error"; error: ApiError };

function CanITab({ clusterId, namespaces }: { clusterId: ClusterId; namespaces: string[] }) {
  const { t } = useTranslation();
  const page = useRbacPageState(clusterId);
  const patch = useRbacStore((s) => s.patch);
  const kinds = useClusterKinds(clusterId);
  const [review, setReview] = useState<Pending<RulesReview>>({ state: "idle" });
  const [answer, setAnswer] = useState<Pending<AccessAnswer>>({ state: "idle" });
  const form = page.canI;
  const setForm = (p: Partial<CanIForm>) => patch(clusterId, { canI: { ...form, ...p } });

  const listRules = (e: FormEvent) => {
    e.preventDefault();
    const ns = page.reviewNamespace.trim();
    if (!ns) return;
    setReview({ state: "loading" });
    api.rbac.rulesReview(clusterId, ns).then(
      (value) => setReview({ state: "done", value }),
      (err: unknown) => setReview({ state: "error", error: toApiError(err) }),
    );
  };
  const grants = useMemo(
    () => (review.state === "done" ? grantsOfReview(rulesOfReview(review.value), review.value.namespace) : []),
    [review],
  );

  const ask = (e: FormEvent) => {
    e.preventDefault();
    const resolved = resolveResource(form.resource, form.subresource, kinds.kinds);
    if (!resolved || !form.verb.trim()) return;
    setAnswer({ state: "loading" });
    api.rbac
      .canI(clusterId, [
        {
          verb: form.verb.trim(),
          group: resolved.group,
          resource: resolved.resource,
          subresource: resolved.subresource,
          name: form.name.trim(),
          namespace: resolved.clusterScoped ? "" : form.namespace.trim(),
          nonResourceUrl: "",
        },
      ])
      .then(
        ([value]) => setAnswer(value ? { state: "done", value } : { state: "idle" }),
        (err: unknown) => setAnswer({ state: "error", error: toApiError(err) }),
      );
  };

  const answerText = (a: AccessAnswer) => (a.allowed ? t("rbac:canI.allowed") : a.denied ? t("rbac:canI.denied") : t("rbac:canI.notAllowed"));

  return (
    <div className="rbac-tab">
      <p className="rbac-note">{t("rbac:canI.authoritative")}</p>
      <h3 className="rbac-heading">{t("rbac:canI.askTitle")}</h3>
      <form className="rbac-form" onSubmit={ask} aria-label={t("rbac:canI.askTitle")}>
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:whoCan.verb")}</span>
          <input className="rbac-input rbac-input--short" list="rbac-verbs" value={form.verb} spellCheck={false} onChange={(e) => setForm({ verb: e.target.value })} />
        </label>
        <label className="rbac-field rbac-field--grow">
          <span className="rbac-field__label">{t("rbac:whoCan.resource")}</span>
          <input className="rbac-input" list="rbac-resources" value={form.resource} placeholder={t("rbac:whoCan.resourcePlaceholder")} spellCheck={false} onChange={(e) => setForm({ resource: e.target.value })} />
        </label>
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:whoCan.subresource")}</span>
          <input className="rbac-input rbac-input--short" value={form.subresource} placeholder={t("rbac:whoCan.subresourcePlaceholder")} spellCheck={false} onChange={(e) => setForm({ subresource: e.target.value })} />
        </label>
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:whoCan.name")}</span>
          <input className="rbac-input rbac-input--short" value={form.name} spellCheck={false} onChange={(e) => setForm({ name: e.target.value })} />
        </label>
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:whoCan.namespace")}</span>
          <input className="rbac-input rbac-input--short" list="rbac-namespaces" value={form.namespace} placeholder={t("rbac:whoCan.anyNamespace")} spellCheck={false} onChange={(e) => setForm({ namespace: e.target.value })} />
        </label>
        <Button type="submit" variant="primary" disabled={!form.verb.trim() || !form.resource.trim() || answer.state === "loading"}>
          {t("rbac:canI.ask")}
        </Button>
        <Button onClick={() => { setForm(EMPTY_CAN_I); setAnswer({ state: "idle" }); }}>{t("rbac:canI.clear")}</Button>
      </form>
      {answer.state === "loading" && <p className="dt-muted" role="status">{t("rbac:canI.asking")}</p>}
      {answer.state === "error" && <ErrorState error={answer.error} />}
      {answer.state === "done" && (
        <div className="rbac-answer" role="status">
          <strong className={answer.value.allowed ? "rbac-answer--yes" : "rbac-answer--no"}>{answerText(answer.value)}</strong>
          {answer.value.reason && <span className="dt-muted">{t("rbac:canI.reason", { reason: answer.value.reason })}</span>}
          {answer.value.evaluationError && <span className="rbac-notes__warn">{t("rbac:canI.evaluationError", { error: answer.value.evaluationError })}</span>}
        </div>
      )}

      <h3 className="rbac-heading">{t("rbac:canI.reviewTitle")}</h3>
      <form className="rbac-form" onSubmit={listRules} aria-label={t("rbac:canI.reviewTitle")}>
        <label className="rbac-field">
          <span className="rbac-field__label">{t("rbac:whoCan.namespace")}</span>
          <input className="rbac-input rbac-input--short" list="rbac-namespaces" value={page.reviewNamespace} spellCheck={false} onChange={(e) => patch(clusterId, { reviewNamespace: e.target.value })} />
        </label>
        <Button type="submit" variant="primary" disabled={!page.reviewNamespace.trim() || review.state === "loading"}>
          {t("rbac:canI.review")}
        </Button>
      </form>
      {review.state === "loading" && <p className="dt-muted" role="status">{t("rbac:canI.reviewing")}</p>}
      {review.state === "error" && (review.error.code === "forbidden" ? <p className="rbac-note rbac-note--warn">{t("rbac:canI.forbidden")}</p> : <ErrorState error={review.error} />)}
      {review.state === "done" && (
        <>
          {review.value.incomplete && (
            <p className="rbac-note rbac-note--warn">
              {review.value.evaluationError ? t("rbac:canI.incompleteBecause", { error: review.value.evaluationError }) : t("rbac:canI.incomplete")}
            </p>
          )}
          <PermissionMatrix grants={grants} showSource={false} label={t("rbac:canI.matrixLabel", { namespace: review.value.namespace })} />
        </>
      )}
      <datalist id="rbac-verbs">
        {COMMON_VERBS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="rbac-resources">
        {resourceSuggestions(kinds.kinds).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="rbac-namespaces">
        {namespaces.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );
}

// ---------- The page ----------

export function RbacPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const page = useRbacPageState(clusterId);
  const patch = useRbacStore((s) => s.patch);
  const selected = useSelectedNamespaces(clusterId);
  // The "Can I" tab needs no objects: nothing is watched while it is open.
  const computed = page.tab !== "canI" && selected !== undefined;
  const rbac = useRbacData(clusterId, computed ? { ...ALL_LISTS, namespaces: selected } : {});
  const namespaces = useMemo(() => namespacesOf(rbac, selected ?? null), [rbac, selected]);
  const tabs: { id: RbacTab; label: string }[] = [
    { id: "subject", label: t("rbac:page.tabs.subject") },
    { id: "whoCan", label: t("rbac:page.tabs.whoCan") },
    { id: "canI", label: t("rbac:page.tabs.canI") },
  ];
  return (
    <div className="rbac-page">
      <h2 className="rbac-page__title">{t("rbac:page.title")}</h2>
      {computed && selected && selected.length > 0 && (
        <p className="dt-muted">{t("rbac:page.filtered", { count: selected.length, namespaces: formatList(selected) })}</p>
      )}
      <Tabs label={t("rbac:page.tabsLabel")} tabs={tabs} selected={page.tab} onSelect={(tab) => patch(clusterId, { tab })}>
        {page.tab === "subject" && <SubjectTab clusterId={clusterId} rbac={rbac} namespaces={namespaces} />}
        {page.tab === "whoCan" && <WhoCanTab clusterId={clusterId} rbac={rbac} namespaces={namespaces} />}
        {page.tab === "canI" && <CanITab clusterId={clusterId} namespaces={namespaces} />}
      </Tabs>
      {computed && rbac.unavailable.length === 4 && <EmptyState title={t("rbac:lists.nothing")} />}
    </div>
  );
}

registerPage({
  id: RBAC_PAGE,
  section: "accessControl",
  order: 60,
  labelKey: "rbac:sidebar.page",
  icon: "accessControl",
  Component: RbacPage,
});
