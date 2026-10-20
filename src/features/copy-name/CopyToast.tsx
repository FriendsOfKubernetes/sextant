// The confirmation of a copy (#229). The live region is always in the page, so a screen reader announces the text
// put into it; the message disappears by itself after `TOAST_MS`.
import { useEffect } from "react";
import { hideToast, TOAST_MS, useToast } from "./toast";

export function CopyToast() {
  const message = useToast((s) => s.message);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => hideToast(message.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <div className="copy-toast" role="status">
      {message && (
        <span key={message.id} className={`copy-toast__message copy-toast__message--${message.tone}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
