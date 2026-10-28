import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterId, type ObjectRef } from "../../api";
import { Button, Icon } from "../../components";
import { ALL_DETAILS_SECTIONS, savedDetailsChoices, saveAllDetailsChoices, saveDetailsChoice, useDetailsEdits } from "./disclosureState";
import "./disclosure.css";

interface DisclosureState {
  choices: Record<string, boolean>;
  ready: boolean;
  setOpen: (path: string, open: boolean) => void;
  setAll: (open: boolean) => void;
}
const Disclosure = createContext<DisclosureState | null>(null);
const SectionPath = createContext<{ path: string; depth: number } | null>(null);

/** A session-only choice belongs to one opened object; persisted choices deliberately exclude name, ns and version. */
export function DetailsDisclosureProvider(props: { clusterId: ClusterId; objectRef: ObjectRef; children: ReactNode }) {
  const { clusterId, objectRef } = props;
  const key = JSON.stringify([clusterId, objectRef.kind.group, objectRef.kind.kind, objectRef.namespace, objectRef.name]);
  return <DisclosureSession key={key} {...props} />;
}

function DisclosureSession({ clusterId, objectRef, children }: { clusterId: ClusterId; objectRef: ObjectRef; children: ReactNode }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [session, setSession] = useState<Record<string, boolean>>({});
  const mode = settings?.appearance.detailsSectionMemory ?? "global";
  const cluster = mode === "cluster" ? clusterId : null;
  const kind = `${objectRef.kind.group}/${objectRef.kind.kind}`;
  const edit = useDetailsEdits(cluster, kind);
  const saved = savedDetailsChoices(settings, cluster, kind);
  const ready = settings !== null;
  const state = useMemo<DisclosureState>(() => ({
    choices: mode === "none" ? session : edit?.replace ? edit.choices : { ...saved, ...edit?.choices },
    ready,
    setOpen: (path, open) => {
      if (!ready) return;
      if (mode === "none") setSession((s) => ({ ...s, [path]: open }));
      else saveDetailsChoice(cluster, kind, path, open);
    },
    setAll: (open) => {
      if (!ready) return;
      if (mode === "none") setSession({ [ALL_DETAILS_SECTIONS]: open });
      else saveAllDetailsChoices(cluster, kind, open);
    },
  }), [mode, session, saved, edit, cluster, kind, ready]);
  return <Disclosure.Provider value={state}>
    {mode !== "none" && edit?.error && <p role="alert" className="details__save-error">{t("details:sections.saveFailed")}</p>}
    {children}
  </Disclosure.Provider>;
}

/** One settings write for the whole kind; no traversal or mounting of hidden descendants. */
export function DetailsSectionControls() {
  const { t } = useTranslation();
  const state = useContext(Disclosure);
  if (!state) return null;
  return <div className="details__section-controls" role="group" aria-label={t("details:sections.controls")}>
    <Button size="compact" disabled={!state.ready} onClick={() => state.setAll(true)}>{t("details:sections.expandAll")}</Button>
    <Button size="compact" disabled={!state.ready} onClick={() => state.setAll(false)}>{t("details:sections.collapseAll")}</Button>
  </div>;
}

export function DetailsSectionScope({ id, children }: { id: string; children: ReactNode }) {
  const value = useMemo(() => ({ path: id, depth: 0 }), [id]);
  return <SectionPath.Provider value={value}>{children}</SectionPath.Provider>;
}

/** Also lets an owning feature suspend its hooks, without CSS-hiding a still-running poller. */
export function useDetailsDisclosure(id: string, defaultOpen = true) {
  const state = useContext(Disclosure);
  const parent = useContext(SectionPath);
  if (!state || !parent) return null;
  const path = `${parent.path}/${id}`;
  return { path, depth: parent.depth, ready: state.ready, open: state.ready && (state.choices[path] ?? state.choices[ALL_DETAILS_SECTIONS] ?? defaultOpen), setOpen: (open: boolean) => state.setOpen(path, open) };
}

export interface DetailsBlockProps {
  /** Stable semantic ID, never an object name, translated title or position in the rendered list. */
  id?: string;
  title?: ReactNode;
  /** Preserve a feature's named region when its heading moves into the disclosure. */
  label?: string;
  children: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
}

export function DetailsBlock({ id, title, label, children, actions, badge, defaultOpen }: DetailsBlockProps) {
  const scoped = useDetailsDisclosure(id ?? "content", defaultOpen ?? true);
  const [localOpen, setLocalOpen] = useState(defaultOpen ?? true);
  const disclosure = scoped ?? (defaultOpen !== undefined && id ? { path: id, depth: 0, ready: true, open: localOpen, setOpen: setLocalOpen } : null);
  if (!title || !id || !disclosure) return <StaticDetailsBlock title={title} label={label} actions={actions} badge={badge}>{children}</StaticDetailsBlock>;
  return <CollapsibleDetailsBlock disclosure={disclosure} title={title} label={label} actions={actions} badge={badge}>{children}</CollapsibleDetailsBlock>;
}

function StaticDetailsBlock({ title, label, children, actions, badge }: DetailsBlockProps) {
  const Container = label ? "section" : "div";
  return <Container className="dt-block" aria-label={label}>
    {(title || actions) && <div className="dt-block__head">{title && <h3 className="dt-block__title" tabIndex={-1}>{title}{badge}</h3>}{actions}</div>}
    {children}
  </Container>;
}

function CollapsibleDetailsBlock({ disclosure, title, label, children, actions, badge }: DetailsBlockProps & { disclosure: NonNullable<ReturnType<typeof useDetailsDisclosure>> }) {
  const bodyId = useId();
  const Container = label ? "section" : "div";
  const { path, depth, ready, open, setOpen } = disclosure;
  const Heading = depth === 0 ? "h3" : depth === 1 ? "h4" : "h5";
  const blockClass = depth === 0 ? "dt-block dt-block--disclosure dt-disclosure-root" : "dt-block dt-block--disclosure dt-disclosure-nested";
  const titleClass = depth === 0 ? "dt-block__title dt-disclosure-title" : "dt-block__title dt-disclosure-title dt-disclosure-title--nested";
  return <Container className={blockClass} aria-label={label} data-depth={depth} data-disclosure={path} data-open={open}>
    <div className="dt-block__head dt-disclosure-head">
      <Heading className={titleClass}>
        <button type="button" className="dt-disclosure" disabled={!ready} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} /><span>{title}</span>{badge}
        </button>
      </Heading>
      {actions && <div className="dt-block__actions">{actions}</div>}
    </div>
    <div id={bodyId} className={depth === 0 ? "dt-block__body dt-disclosure-root-body" : "dt-block__body"} hidden={!open}>
      {open && <DetailsSectionScopeBody path={path} depth={depth + 1}>{children}</DetailsSectionScopeBody>}
    </div>
  </Container>;
}

function DetailsSectionScopeBody({ path, depth, children }: { path: string; depth: number; children: ReactNode }) {
  const value = useMemo(() => ({ path, depth }), [path, depth]);
  return <SectionPath.Provider value={value}>{children}</SectionPath.Provider>;
}
