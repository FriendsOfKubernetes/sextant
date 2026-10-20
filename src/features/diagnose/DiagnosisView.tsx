// The path view: each link of the path in order with its status, the reason in plain words and links to the objects;
// branches (an Ingress's paths, a route's backends) fold, the ones with a problem open. A chain that broke says the
// checks after the broken link were not run.
import { useTranslation } from "react-i18next";
import { Badge, Icon } from "../../components";
import type { ObjectRef } from "../../api";
import { chainStatus, firstBroken, type Chain, type Finding, type LinkRef, type Status } from "./model";
import { phraseText, policyLines, STATUS_TONE, statusText } from "./text";

export interface DiagnosisViewProps {
  chain: Chain;
  /** Opens an object's details (the view closes its dialog first, when it is in one). */
  onOpen: (ref: ObjectRef) => void;
}

function StatusMark({ status }: { status: Status }) {
  const { t } = useTranslation();
  return (
    <span className={`dg-mark dg-mark--${status}`}>
      <Badge tone={STATUS_TONE[status]}>{statusText(t, status)}</Badge>
    </span>
  );
}

function ObjectButton({ target, onOpen }: { target: LinkRef; onOpen: (ref: ObjectRef) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="rt-link"
      aria-label={t("resources:table.openObject", { kind: target.kind.kind, name: target.name })}
      onClick={() => onOpen({ kind: target.kind, namespace: target.namespace, name: target.name })}
    >
      {target.name}
    </button>
  );
}

function Step({ finding, onOpen }: { finding: Finding; onOpen: (ref: ObjectRef) => void }) {
  const { t } = useTranslation();
  const notes = [...(finding.notes ?? []).map((n) => phraseText(t, n)), ...policyLines(t, finding.policies ?? [])];
  return (
    <li className={`dg-step dg-step--${finding.status}`} data-check={finding.id}>
      <StatusMark status={finding.status} />
      <div className="dg-step__body">
        <p className="dg-step__text">{phraseText(t, finding.text)}</p>
        {notes.length > 0 && (
          <ul className="dg-step__notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {finding.links && finding.links.length > 0 && (
          <span className="dg-step__links">
            {finding.links.map((l) => (
              <ObjectButton key={`${l.kind.kind}/${l.namespace ?? ""}/${l.name}`} target={l} onOpen={onOpen} />
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

function ChainSteps({ chain, onOpen }: { chain: Chain; onOpen: (ref: ObjectRef) => void }) {
  const { t } = useTranslation();
  return (
    <>
      {chain.findings.length > 0 && (
        <ol className="dg-steps">
          {chain.findings.map((f) => (
            <Step key={f.id} finding={f} onOpen={onOpen} />
          ))}
        </ol>
      )}
      {chain.stopped && <p className="dg-stopped">{t("diagnose:stopped")}</p>}
      {chain.chains.map((sub, i) => (
        <Branch key={i} chain={sub} onOpen={onOpen} />
      ))}
    </>
  );
}

function Branch({ chain, onOpen }: { chain: Chain; onOpen: (ref: ObjectRef) => void }) {
  const { t } = useTranslation();
  const status = chainStatus(chain);
  return (
    <details className="dg-branch" open={status !== "ok"}>
      <summary className="dg-branch__summary">
        <Icon name="chevronRight" className="dg-branch__chevron" />
        <StatusMark status={status} />
        <span className="dg-branch__title">{chain.title ? phraseText(t, chain.title) : null}</span>
      </summary>
      <div className="dg-branch__body">
        <ChainSteps chain={chain} onOpen={onOpen} />
      </div>
    </details>
  );
}

export function DiagnosisView({ chain, onOpen }: DiagnosisViewProps) {
  const { t } = useTranslation();
  const status = chainStatus(chain);
  const broken = firstBroken(chain);
  const summary = broken
    ? t("diagnose:summary.broken", { reason: phraseText(t, broken.text) })
    : t(`diagnose:summary.${status}`);
  return (
    <div className="dg-view">
      <p className={`dg-summary dg-summary--${status}`} role="status">
        <StatusMark status={status} />
        <span>{summary}</span>
      </p>
      <p className="dg-banner">{t("diagnose:banner")}</p>
      <ChainSteps chain={chain} onOpen={onOpen} />
    </div>
  );
}
