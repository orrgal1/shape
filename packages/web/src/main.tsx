import "@xyflow/react/dist/style.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const host = document.getElementById("root");
if (host === null) throw new Error("index.html is missing #root");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
