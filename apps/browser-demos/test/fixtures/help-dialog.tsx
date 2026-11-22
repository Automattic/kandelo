import * as React from "react";
import { createRoot } from "react-dom/client";
import { HelpDialog } from "../../pages/kandelo/app/HelpDialog";
import { initializeTheme } from "../../pages/kandelo/app/theme";
import "../../pages/kandelo/tokens.css";
import "../../pages/kandelo/styles.css";

initializeTheme();
const root = createRoot(document.getElementById("root")!);
root.render(<HelpDialog onClose={() => root.unmount()} />);
