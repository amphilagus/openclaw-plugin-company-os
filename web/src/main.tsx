import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import "./task-attachments.css";
import "./task-tree-controls.css";
import "./meeting-header.css";
import "./system-avatar.css";
import "./boss-participation.css";
import "./meeting-dispatch.css";
import "./meeting-closeout.css";
import "./meeting-governance.css";
import "./task-reminder.css";
import "./task-checkin.css";
import "./task-review.css";
import "./notice-reminder.css";
import "./self-governance.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
