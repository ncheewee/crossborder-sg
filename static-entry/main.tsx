import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CrossBorderApp from "../app/page";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrossBorderApp />
  </StrictMode>,
);
