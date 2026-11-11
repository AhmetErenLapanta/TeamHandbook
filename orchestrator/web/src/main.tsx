import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readPref, THEME_KEY } from "./prefs";
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/components.css";
import "./styles.css";

applyTheme(readPref(THEME_KEY));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
