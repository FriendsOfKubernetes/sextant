import { useState } from "react";
import { toApiError, type ApiError, type ForwardInfo } from "../../api";
import { ForwardDialog } from "./ForwardDialog";
import { restartForward } from "./hooks";

/** A failed retry may already have stopped the old listener; keep its editable parameters outside that row. */
export function useForwardRetry() {
  const [failed, setFailed] = useState<{ forward: ForwardInfo; error: ApiError } | null>(null);
  const retry = async (forward: ForwardInfo) => {
    try { await restartForward(forward); }
    catch (err) { setFailed({ forward, error: toApiError(err) }); }
  };
  return {
    retry,
    retryDialog: failed && <ForwardDialog clusterId={failed.forward.cluster} target={failed.forward.target}
      ports={[failed.forward.remotePort]} initialLocalPort={failed.forward.localPort} initialError={failed.error}
      close={() => setFailed(null)} />,
  };
}
