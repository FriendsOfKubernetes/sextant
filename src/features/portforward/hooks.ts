import { useEffect, useState } from "react";
import { api, events, toApiError, type ApiError, type ForwardInfo } from "../../api";

export interface PortForwards {
  forwards: ForwardInfo[];
  loaded: boolean;
  error: ApiError | null;
}

/**
 * The active port forwards of the application: `portforward_list` once, then the full list from every
 * `portforwards` event. The listener is attached first, so a change between the two is not lost.
 */
export function usePortForwards(): PortForwards {
  const [state, setState] = useState<PortForwards>({ forwards: [], loaded: false, error: null });

  useEffect(() => {
    let cancelled = false;
    let pushed = false;
    const unlisten = events.onPortForwards((forwards) => {
      pushed = true;
      if (!cancelled) setState({ forwards, loaded: true, error: null });
    });
    unlisten.then(
      () => {
        if (cancelled) return;
        api.portForward.list().then(
          (forwards) => {
            // An event that arrived while the list was loading is newer.
            if (!cancelled && !pushed) setState({ forwards, loaded: true, error: null });
          },
          (err: unknown) => {
            if (!cancelled) setState((s) => ({ ...s, loaded: true, error: toApiError(err) }));
          },
        );
      },
      (err: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, loaded: true, error: toApiError(err) }));
      },
    );
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  return state;
}
