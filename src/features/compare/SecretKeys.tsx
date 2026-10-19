// Two Secrets compared by key: where each key is and whether the values are the same. The backend hashed the values;
// no value is fetched until the user clicks "Show values" on a key, and then only through `secret_value` (one key of
// one live Secret, the same command and rules as the Secret's details).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ClusterId, type SecretKeyComparison } from "../../api";
import { Badge, Button, type BadgeTone } from "../../components";
import { ResizableTable } from "../../components/Table";

/** A live Secret whose values may be revealed. */
export interface RevealableSecret {
  clusterId: ClusterId;
  namespace: string;
  name: string;
}

export interface SecretKeysProps {
  keys: readonly SecretKeyComparison[];
  leftTitle: string;
  rightTitle: string;
  /** A side that is a live Secret; `null` for a manifest or a last-applied configuration (no values to show). */
  revealLeft: RevealableSecret | null;
  revealRight: RevealableSecret | null;
}

function state(key: SecretKeyComparison): { tone: BadgeTone; text: string } {
  if (!key.onLeft) return { tone: "warning", text: "compare:secret.onlyRight" };
  if (!key.onRight) return { tone: "warning", text: "compare:secret.onlyLeft" };
  return key.equal ? { tone: "success", text: "compare:secret.equal" } : { tone: "danger", text: "compare:secret.different" };
}

export function SecretKeys({ keys, leftTitle, rightTitle, revealLeft, revealRight }: SecretKeysProps) {
  const { t } = useTranslation();
  if (keys.length === 0) return <p className="compare-muted">{t("compare:secret.noKeys")}</p>;
  return (
    <div className="compare-secret">
      <p className="compare-muted">{t("compare:secret.hint")}</p>
      <ResizableTable tableId="compare.secretKeys" className="compare-table" aria-label={t("compare:secret.label")}>
        <thead>
          <tr>
            <th>{t("compare:secret.key")}</th>
            <th>{t("compare:secret.state")}</th>
            <th aria-label={t("compare:secret.values")} />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <KeyRow
              key={key.key}
              entry={key}
              leftTitle={leftTitle}
              rightTitle={rightTitle}
              revealLeft={key.onLeft ? revealLeft : null}
              revealRight={key.onRight ? revealRight : null}
            />
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

interface Revealed {
  left: string | null;
  right: string | null;
  error: string | null;
}

function KeyRow({
  entry,
  leftTitle,
  rightTitle,
  revealLeft,
  revealRight,
}: {
  entry: SecretKeyComparison;
  leftTitle: string;
  rightTitle: string;
  revealLeft: RevealableSecret | null;
  revealRight: RevealableSecret | null;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const { tone, text } = state(entry);
  const canReveal = revealLeft !== null || revealRight !== null;
  const read = (side: RevealableSecret | null) =>
    side ? api.resources.secretValue(side.clusterId, side.namespace, side.name, entry.key) : Promise.resolve(null);
  const reveal = () => {
    setBusy(true);
    Promise.all([read(revealLeft), read(revealRight)])
      .then(([left, right]) => setRevealed({ left, right, error: null }))
      .catch((err: unknown) => setRevealed({ left: null, right: null, error: toApiError(err).message }))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <tr>
        <td className="compare-mono">{entry.key}</td>
        <td>
          <Badge tone={tone}>{t(text)}</Badge>
        </td>
        <td>
          {canReveal && (
            <Button
              size="compact"
              icon={revealed ? "eyeOff" : "eye"}
              disabled={busy}
              onClick={revealed ? () => setRevealed(null) : reveal}
            >
              {revealed ? t("compare:secret.hide") : t("compare:secret.show")}
            </Button>
          )}
        </td>
      </tr>
      {revealed && (
        <tr className="compare-secret__values">
          <td colSpan={3}>
            {revealed.error ? (
              <span className="compare-error">{revealed.error}</span>
            ) : (
              <dl>
                {revealLeft && <dt>{leftTitle}</dt>}
                {revealLeft && <dd className="compare-mono">{revealed.left}</dd>}
                {revealRight && <dt>{rightTitle}</dt>}
                {revealRight && <dd className="compare-mono">{revealed.right}</dd>}
              </dl>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
