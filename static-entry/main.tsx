import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CrossBorderApp from "../app/page";
import "../app/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("CrossBorder.sg root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <CrossBorderApp />
  </StrictMode>,
);

window.addEventListener("pageshow", () => {
  const root = document.getElementById("root");
  if (root && root.childElementCount === 0) {
    const key = "cb-empty-root-reload";
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      window.location.reload();
    }
  } else {
    sessionStorage.removeItem("cb-empty-root-reload");
  }
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      })
      .then((registration) => {
        void registration.update();
        const wake = (worker: ServiceWorker | null) => {
          worker?.postMessage({ type: "SKIP_WAITING" });
        };
        if (registration.waiting) wake(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed") wake(worker);
          });
        });
      });
  });
}
