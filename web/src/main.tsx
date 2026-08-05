import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import "./boss-participation.css";
import "./meeting-dispatch.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
