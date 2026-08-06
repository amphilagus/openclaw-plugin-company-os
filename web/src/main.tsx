import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import "./boss-participation.css";
import "./meeting-dispatch.css";
import "./meeting-closeout.css";
import "./task-reminder.css";
import "./task-checkin.css";
import "./task-review.css";
import "./notice-reminder.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
