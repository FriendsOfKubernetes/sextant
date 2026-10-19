import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resetZoomOnLoad } from "./api";
import { App } from "./app/App";
import "./app/features";
import { startI18n, startupLanguage } from "./i18n";
import "./styles/fonts.css";
import "./styles/global.css";

// The language applied last time (or the system's on a new install) until the settings load; App then applies the
// saved choice. Its texts are read before the first render, so the window does not flash English first.
// The zoom keys count from 100 % on each load: the window starts there too (src/api/zoom.ts).
resetZoomOnLoad();
void startI18n(startupLanguage()).then(() => {
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
});
