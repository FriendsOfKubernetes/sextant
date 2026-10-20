// Tabs with one panel: the tab list, and the content of the selected tab (`children`) in a tab panel (only the
// selected tab has `aria-controls`: the other panels are not rendered). The caller
// holds the selection. Keyboard as in the WAI-ARIA tabs pattern: only the selected tab is in the tab order, ←/→ move
// to the previous/next tab (wrapping around), Home/End to the first/last; moving selects the tab and focuses it.
//
//   <Tabs label={t("…containers")} tabs={[{ id: "app", label: "app" }]} selected={id} onSelect={setId}>
//     <ContainerFields container={selectedContainer} />
//   </Tabs>
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { revealInStrip, useStripScroll } from "./stripScroll";
import "./tabs.css";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Tooltip of the tab. */
  title?: string;
}

export interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: Array<TabItem<T>>;
  selected: T;
  onSelect(id: NoInfer<T>): void;
  /** Content of the selected tab. */
  children: ReactNode;
  /** Prefix of the element ids (`<prefix>-tab-<id>`, `<prefix>-panel-<id>`); default: a generated one. */
  idPrefix?: string;
  className?: string;
}

export function Tabs<T extends string>({ label, tabs, selected, onSelect, children, idPrefix, className }: TabsProps<T>) {
  const generated = useId();
  const prefix = idPrefix ?? generated;
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const current = tabs.some((tab) => tab.id === selected) ? selected : tabs[0]?.id;
  // The list scrolls sideways without a scrollbar (stripScroll.ts): the wheel scrolls it, the selected tab is shown.
  useStripScroll(list, [tabs.length]);
  useEffect(() => {
    if (current !== undefined) revealInStrip(list.current, buttons.current.get(current));
  }, [current]);
  const tabId = (id: T) => `${prefix}-tab-${id}`;
  const panelId = (id: T) => `${prefix}-panel-${id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    buttons.current.get(id)?.focus();
  };

  return (
    <div className={className ? `tabs ${className}` : "tabs"}>
      <div ref={list} className="tabs__list" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const active = tab.id === current;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) buttons.current.set(tab.id, el);
                else buttons.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              className="tabs__tab"
              aria-selected={active}
              aria-controls={active ? panelId(tab.id) : undefined}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {current !== undefined && (
        <div className="tabs__panel" role="tabpanel" id={panelId(current)} aria-labelledby={tabId(current)} tabIndex={0}>
          {children}
        </div>
      )}
    </div>
  );
}
