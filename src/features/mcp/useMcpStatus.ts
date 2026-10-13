// The server's status: read once the server is on, then kept current by the `mcp-status` event.
import { useEffect, useRef, useState } from "react";
import { api, events, type McpStatus } from "../../api";

export function useMcpStatus(enabled: boolean): McpStatus | null {
  const [status, setStatus] = useState<McpStatus | null>(null);
  // An event that comes while a request is on its way is newer than the request's answer.
  const eventAfterRequest = useRef(false);

  useEffect(() => {
    let live = true;
    const unsubscribe = events.onMcpStatus((next) => {
      if (!live) return;
      eventAfterRequest.current = true;
      setStatus(next);
    });
    return () => {
      live = false;
      void unsubscribe.then((off) => off(), () => undefined);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    eventAfterRequest.current = false;
    api.mcp.status().then(
      (next) => {
        if (live && !eventAfterRequest.current) setStatus(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled]);

  return status;
}
