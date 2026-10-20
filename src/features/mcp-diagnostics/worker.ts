// What every diagnostic worker gets, and the one way it answers.
import { useEffect, useRef } from "react";
import type { DiagnosticAnswer, DiagnosticRequest } from "../../api";

export interface WorkerProps {
  request: DiagnosticRequest;
  /** The settle time is over: answer with what there is. */
  expired: boolean;
  /** Answers the request (only the first call counts). */
  done: (answer: DiagnosticAnswer) => void;
}

/**
 * Answers once, as soon as `ready` (or `expired`, then with `incomplete: true`): `build` makes the result; a throw is
 * the answer's error.
 */
export function useAnswer(
  { expired, done }: Pick<WorkerProps, "expired" | "done">,
  ready: boolean,
  build: (incomplete: boolean) => Record<string, unknown>,
): void {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !(ready || expired)) return;
    sent.current = true;
    try {
      done({ type: "ok", result: { ...build(!ready), incomplete: !ready } });
    } catch (err) {
      done({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });
}
