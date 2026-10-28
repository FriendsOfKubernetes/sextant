import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { FilterExpression } from "../../api/generated/FilterExpression";
import type { TableFilters } from "../../api/generated/TableFilters";
import { Button, Dialog } from "../../components";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { ConditionFields, conditionDraft, draftCondition, type ConditionDraft } from "./ConditionFields";
import { columnLabel } from "./labels";
import { compileTableFilters, columnFilterCount } from "./model";
import { FILTER_LIMITS, readTableFilters } from "./validation";
import { sampleFilterType } from "./facets";

interface DraftRule { id: number; type: "rule"; column: string; valueType: string | null; condition: ConditionDraft }
interface DraftGroup { id: number; type: "group"; operator: "and" | "or"; children: DraftNode[] }
type DraftNode = DraftRule | DraftGroup;
const GROUP_OPERATORS = ["and", "or"] as const;

function definition(id: string, columns: readonly ColumnDef[]): ColumnDef {
  return columns.find((column) => column.id === id) ?? { id, value: () => undefined };
}
function hydrate(expression: FilterExpression, columns: readonly ColumnDef[], nextId: () => number): DraftNode {
  return expression.type === "rule" ? { id: nextId(), type: "rule", column: expression.column,
    valueType: definition(expression.column, columns).filter?.type ?? (typeof expression.condition.value === "number" ? "number" : typeof expression.condition.value === "boolean" ? "boolean" : typeof expression.condition.value === "string" ? "string" : null),
    condition: conditionDraft(definition(expression.column, columns), expression.condition) }
    : { id: nextId(), type: "group", operator: expression.operator, children: expression.children.map((child) => hydrate(child, columns, nextId)) };
}
function persist(node: DraftNode, columns: readonly ColumnDef[]): FilterExpression | null {
  if (node.type === "rule") {
    const column = definition(node.column, columns);
    const condition = draftCondition(node.condition, column, node.valueType ?? column.filter?.type ?? "string");
    if (!condition) throw new Error("invalid condition");
    return { type: "rule", column: node.column, condition };
  }
  const children = node.children.map((child) => persist(child, columns)).filter((child): child is FilterExpression => child !== null);
  return children.length === 0 ? null : children.length === 1 ? children[0]! : { type: "group", operator: node.operator, children };
}
function draftSize(node: DraftNode): number {
  return node.type === "rule" ? 1 : 1 + node.children.reduce((count, child) => count + draftSize(child), 0);
}
function draftColumns(node: DraftNode, into = new Set<string>()): Set<string> {
  if (node.type === "rule") into.add(node.column);
  else for (const child of node.children) draftColumns(child, into);
  return into;
}

function initialDraft(advanced: FilterExpression | null, columns: readonly ColumnDef[], nextId: () => number): DraftGroup {
  const root = advanced ? hydrate(advanced, columns, nextId) : null;
  return root?.type === "group" ? root : { id: nextId(), type: "group", operator: "and", children: root ? [root] : [] };
}

function parseDraft(draft: DraftGroup, filters: TableFilters, columns: readonly ColumnDef[]) {
  try { return { filters: readTableFilters({ ...filters, advanced: persist(draft, columns) }), error: false }; }
  catch { return { filters: null, error: true }; }
}

function previewMatches(objects: ReadonlyMap<string, KubeObject>, accept: (obj: KubeObject) => boolean,
  compiled: ReturnType<typeof compileTableFilters> | null, context: CellContext) {
  let shown = 0; let total = 0;
  for (const obj of objects.values()) {
    if (!accept(obj)) continue;
    total++;
    if (compiled?.matches(obj, context)) shown++;
  }
  return { shown, total };
}

function useAdvancedPreview(draft: DraftGroup, filters: TableFilters, columns: readonly ColumnDef[],
  { objects, context, revision, accept }: {
    objects: ReadonlyMap<string, KubeObject>; context: CellContext; revision: number; accept: (obj: KubeObject) => boolean;
  }) {
  const parsed = useMemo(() => parseDraft(draft, filters, columns), [draft, filters, columns]);
  // Preview work has lower priority than typing; applying still uses the current, fully validated draft.
  const previewFilters = useDeferredValue(parsed.filters);
  const compiled = useMemo(() => previewFilters ? compileTableFilters(previewFilters, columns) : null, [previewFilters, columns]);
  const filterNow = compiled?.needsTime ? context.now : 0;
  const preview = useMemo(() => previewMatches(objects, accept, compiled, context),
    [objects, accept, compiled, revision, context.clusterId, context.kind, filterNow]);
  return { parsed, preview, compiled, pending: previewFilters !== parsed.filters };
}

function adoptTypes(node: DraftNode, columns: readonly ColumnDef[]): DraftNode {
  if (node.type === "rule") {
    if (node.valueType !== null) return node;
    const type = definition(node.column, columns).filter?.type;
    if (!type) return node;
    const condition = type === "boolean" && node.condition.operator === "eq" && node.condition.value === "" && node.condition.upper === ""
      ? { ...node.condition, value: "true" } : node.condition;
    return { ...node, valueType: type, condition };
  }
  let children: DraftNode[] | null = null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    const adopted = adoptTypes(child, columns);
    if (adopted !== child) { children ??= [...node.children]; children[i] = adopted; }
  }
  return children ? { ...node, children } : node;
}

function GroupFields({ group, columns, onChange, onRemove, nextId, depth, canAdd }: {
  group: DraftGroup; columns: readonly ColumnDef[]; onChange: (next: DraftGroup) => void; onRemove?: () => void;
  nextId: () => number; depth: number; canAdd: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLFieldSetElement>(null);
  const pendingFocus = useRef<number | null>(null);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    ref.current?.querySelector<HTMLElement>(`[data-tf-node="${pendingFocus.current}"]`)?.querySelector<HTMLElement>("select, input, button")?.focus();
    pendingFocus.current = null;
  }, [group.children]);
  const change = (id: number, next: DraftNode | null) => onChange({ ...group,
    children: group.children.flatMap((child) => child.id === id ? next ? [next] : [] : [child]) });
  return <fieldset ref={ref} data-tf-node={group.id} className="tf-group"><legend className="visually-hidden">{t(group.operator === "and" ? "filters:all" : "filters:any")}</legend>
    <div className="tf-group-heading"><select className="tf-control" aria-label={t("filters:condition")} value={group.operator}
      onChange={(e) => onChange({ ...group, operator: e.target.value as "and" | "or" })}>
      {GROUP_OPERATORS.map((operator) => <option key={operator} value={operator}>{t(operator === "and" ? "filters:all" : "filters:any")}</option>)}
    </select>{onRemove && <Button iconOnly icon="close" size="compact" label={t("filters:removeGroup")} onClick={onRemove} />}</div>
    <div className="tf-group-children">{group.children.map((child) => child.type === "group"
      ? <GroupFields key={child.id} group={child} columns={columns} onChange={(next) => change(child.id, next)}
        onRemove={() => change(child.id, null)} depth={depth + 1} nextId={nextId} canAdd={canAdd} />
      : <div key={child.id} data-tf-node={child.id} className="tf-advanced-rule">
        <label><span className="tf-label">{t("filters:column")}</span><select className="tf-control" value={child.column} onChange={(e) => {
          const column = e.target.value;
          change(child.id, { ...child, column, valueType: definition(column, columns).filter?.type ?? null, condition: conditionDraft(definition(column, columns)) });
        }}>
          {!columns.some((column) => column.id === child.column) && <option value={child.column}>{child.column}</option>}
          {columns.map((column) => <option key={column.id} value={column.id}>{columnLabel(column, t)}</option>)}
        </select></label>
        <ConditionFields column={definition(child.column, columns)} type={child.valueType ?? definition(child.column, columns).filter?.type ?? "string"}
          draft={child.condition} onChange={(condition) => change(child.id, { ...child, condition })} />
        <Button iconOnly icon="close" size="compact" label={t("filters:removeRule")} onClick={() => change(child.id, null)} />
      </div>)}</div>
    <div className="tf-group-actions"><Button size="compact" icon="add" disabled={!canAdd || depth >= FILTER_LIMITS.depth || !columns.length}
      onClick={() => { const column = columns[0]!; const id = nextId(); pendingFocus.current = id; onChange({ ...group, children: [...group.children,
        { id, type: "rule", column: column.id, valueType: column.filter?.type ?? null, condition: conditionDraft(column) }] }); }}>{t("filters:addRule")}</Button>
      <Button size="compact" disabled={!canAdd || depth >= FILTER_LIMITS.depth - 1} onClick={() => { const id = nextId(); pendingFocus.current = id; onChange({ ...group,
        children: [...group.children, { id, type: "group", operator: "or", children: [] }] }); }}>{t("filters:addGroup")}</Button></div>
  </fieldset>;
}

function AdvancedHints({ canAdd, error, unavailable }: { canAdd: boolean; error: boolean; unavailable: boolean | undefined }) {
  const { t } = useTranslation();
  return <>
    {!canAdd && <p className="tf-hint">{t("filters:limitReached")}</p>}
    {error && <p className="tf-error" role="alert">{t("filters:invalidValue")}</p>}
    {unavailable && <p className="tf-hint" role="status">{t("filters:advancedSuspended")}</p>}
  </>;
}

export function AdvancedEditor({ filters, columns: definitions, objects, context, revision, accept, onApply, onClose, onInspect }: {
  filters: TableFilters; columns: readonly ColumnDef[]; objects: ReadonlyMap<string, KubeObject>; context: CellContext; revision: number;
  accept: (obj: KubeObject) => boolean; onApply: (advanced: FilterExpression | null) => void; onClose: () => void;
  onInspect: (columns: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => definitions.map((column) => {
    if (column.filter?.type) return column;
    const type = sampleFilterType(column, objects.values(), context);
    return type ? { ...column, filter: { ...column.filter, type } } : column;
  }), [definitions, objects, context.clusterId, context.kind, revision]);
  const sequence = useRef(0);
  const nextId = () => ++sequence.current;
  const [draft, setDraft] = useState(() => initialDraft(filters.advanced, columns, nextId));
  useEffect(() => setDraft((current) => adoptTypes(current, columns) as DraftGroup), [columns]);
  const inspected = [...draftColumns(draft)].sort().join("\0");
  useEffect(() => { onInspect(inspected ? inspected.split("\0") : []); return () => onInspect([]); }, [inspected, onInspect]);
  const { parsed, preview, compiled, pending } = useAdvancedPreview(draft, filters, columns, { objects, context, revision, accept });
  let quickCount = 0;
  for (const filter of Object.values(filters.columns)) quickCount += columnFilterCount(filter);
  const size = draftSize(draft);
  const canAdd = size < FILTER_LIMITS.nodes && size + quickCount < FILTER_LIMITS.conditions;
  return <div className="tf-advanced"><Dialog open title={t("filters:advancedTitle")} onClose={onClose}
    footer={<><span className="tf-preview" role="status" aria-busy={pending}>{t("filters:preview", { shown: preview.shown, count: preview.total })}</span>
      <Button onClick={onClose}>{t("filters:cancel")}</Button><Button variant="primary" disabled={parsed.error}
        onClick={() => { if (parsed.filters) onApply(parsed.filters.advanced); }}>{t("filters:apply")}</Button></>}>
    <GroupFields group={draft} columns={columns} onChange={setDraft} nextId={nextId} depth={1} canAdd={canAdd} />
    <AdvancedHints canAdd={canAdd} error={parsed.error} unavailable={compiled?.advancedUnavailable} />
  </Dialog></div>;
}
