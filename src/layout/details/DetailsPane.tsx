import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { DETAILS_DEFAULT_WIDTH, DETAILS_MIN_WIDTH, useAppStore } from "../../app/store";
import { kindKey } from "../../resources/refs";
import { Splitter } from "../Splitter";

/** Size changes stay in this frame; its children keep their identity, state and subscriptions. */
export function DetailsPane({ kind, narrow, children }: { kind: KindRef; narrow: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const key = kindKey(kind);
  const preferred = useAppStore(s => s.detailsWidths[s.detailsWidthScope === "global" ? "*" : key] ?? DETAILS_DEFAULT_WIDTH);
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  useLayoutEffect(() => {
    const workspace = frame.current?.parentElement;
    if (!workspace) return;
    const update = (width: number) => setAvailable(Math.max(0, Math.floor(width)));
    update(workspace.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(e => e.target === workspace);
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const resizable = !narrow && available > DETAILS_MIN_WIDTH;
  const shown = Math.min(preferred, available);
  return <div ref={frame} className="details-frame" style={{ width: resizable ? preferred : "100%" }}>
    {resizable && <Splitter orientation="vertical" direction={-1} label={t("common:layout.resizeDetails")}
      value={shown} min={DETAILS_MIN_WIDTH} max={available}
      onResize={size => {
        const width = Math.max(DETAILS_MIN_WIDTH, Math.min(available, Math.round(size)));
        if (width !== shown) useAppStore.getState().setDetailsWidth(key, width);
      }} />}
    {children}
  </div>;
}
