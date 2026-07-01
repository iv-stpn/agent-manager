import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found in document");
createRoot(rootEl).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>
);
