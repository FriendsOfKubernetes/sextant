// The window's side of the agents' diagnostic tools (ADR-0094), mounted once by `AppShell` and drawing nothing: each
// `mcp-diagnostic` request runs as a hidden worker that uses the same hooks and engines as the screens (shared,
// bounded watches, released when the worker ends) and answers once with `api.mcp.diagnosticAnswer`. At most
// `MAX_RUNNING` workers run at once — as many as the backend lets wait (`MAX_PENDING` in `src-tauri/src/mcp/window.rs`),
// so an admitted request starts at once and answers within `SETTLE_MS` (20 s), well inside the backend's 40 s
// `WINDOW_TIMEOUT`; a worker answers when its data is in, or after `SETTLE_MS` with what it has (`incomplete`). When
// the backend stops waiting (timed out, the call was dropped, the server stopped) it sends `mcp-diagnostic-cancel`:
// the request is dropped, queued or running, and its worker lets go of its watches.
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { api, events, type DiagnosticAnswer, type DiagnosticRequest, type DiagnosticTool } from "../../api";
import { AutoscalingWorker } from "./autoscaling";
import { ChangesWorker } from "./changes";
import { ConnectivityWorker } from "./connectivity";
import { DiagnoseWorker } from "./diagnose";
import { PermissionsWorker } from "./permissions";
import { ProblemsWorker } from "./problems";
import type { WorkerProps } from "./worker";

/** Workers computing at once: the backend's `MAX_PENDING`, so no admitted request waits behind another. */
export const MAX_RUNNING = 4;
/** Requests held at most (more than `MAX_RUNNING` only while a cancel is on its way). */
export const MAX_QUEUED = 8;
/** How long a worker waits for its data before it answers with what it has. */
export const SETTLE_MS = 20_000;

const WORKERS: Record<DiagnosticTool, ComponentType<WorkerProps>> = {
  problems: ProblemsWorker,
  diagnoseService: DiagnoseWorker,
  connectivity: ConnectivityWorker,
  permissions: PermissionsWorker,
  recentChanges: ChangesWorker,
  autoscaling: AutoscalingWorker,
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A worker that throws while drawing answers with the error instead of breaking the window. */
class Guarded extends Component<{ onError: (message: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(errorText(error));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Running({ request, onDone }: { request: DiagnosticRequest; onDone: (answer: DiagnosticAnswer) => void }) {
  const [expired, setExpired] = useState(false);
  const answered = useRef(false);
  const done = useRef((answer: DiagnosticAnswer) => {
    if (answered.current) return;
    answered.current = true;
    onDone(answer);
  }).current;
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  const Worker = WORKERS[request.tool] as ComponentType<WorkerProps> | undefined;
  useEffect(() => {
    if (!Worker) done({ type: "error", message: `unknown diagnostic ${String(request.tool)}` });
  }, [Worker, done, request.tool]);
  if (!Worker) return null;
  return (
    <Guarded onError={(message) => done({ type: "error", message })}>
      <Worker request={request} expired={expired} done={done} />
    </Guarded>
  );
}

export function DiagnosticsHost() {
  const [queue, setQueue] = useState<DiagnosticRequest[]>([]);

  useEffect(() => {
    let live = true;
    const unsubscribe = events.onMcpDiagnostic((request) => {
      if (!live) return;
      setQueue((q) => {
        if (q.length < MAX_QUEUED) return [...q, request];
        void api.mcp.diagnosticAnswer(request.id, { type: "error", message: "too many diagnostic requests" }).catch(() => {});
        return q;
      });
    });
    // The backend no longer waits: drop the request, whether it waits here or runs (its worker unmounts).
    const unsubscribeCancel = events.onMcpDiagnosticCancel(({ id }) => {
      if (live) setQueue((q) => q.filter((r) => r.id !== id));
    });
    return () => {
      live = false;
      void unsubscribe.then((stop) => stop());
      void unsubscribeCancel.then((stop) => stop());
    };
  }, []);

  const finish = (id: string, answer: DiagnosticAnswer) => {
    // The backend may have stopped waiting (timed out, the agent went away): nothing to do then.
    void api.mcp.diagnosticAnswer(id, answer).catch(() => {});
    setQueue((q) => q.filter((r) => r.id !== id));
  };

  return (
    <>
      {queue.slice(0, MAX_RUNNING).map((request) => (
        <Running key={request.id} request={request} onDone={(answer) => finish(request.id, answer)} />
      ))}
    </>
  );
}
