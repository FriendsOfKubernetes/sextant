import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/features";
import { startI18n, startupLanguage } from "./i18n";
import "./styles/global.css";

// The language applied last time (or the system's on a new install) until the settings load; App then applies the
// saved choice. Its texts are read before the first render, so the window does not flash English first.
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
