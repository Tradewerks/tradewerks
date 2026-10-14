import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { APP_BASE } from "./config";
import { queryClient } from "./lib/queryClient";
import "./index.css";

// The product app. Mounted under APP_BASE so every route and navigate() call inside
// it stays written as "/dispatch/…", "/login", etc. — the basename adds the prefix.
export default function AppRoot() {
	return (
		<QueryClientProvider client={queryClient}>
			<BrowserRouter basename={APP_BASE}>
				<App />
			</BrowserRouter>
		</QueryClientProvider>
	);
}
