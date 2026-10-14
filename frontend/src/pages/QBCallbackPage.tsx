import { useEffect, useState } from "react";
import { APP_BASE } from "../config";

export default function QBCallbackPage() {
	const [status] = useState(
		() => new URLSearchParams(window.location.search).get("qb") ?? "connected",
	);
	const [showFallback, setShowFallback] = useState(false);

	useEffect(() => {
		// Same-tab fallback (popups blocked)
		if (sessionStorage.getItem("qb-oauth-same-tab")) {
			sessionStorage.removeItem("qb-oauth-same-tab");
			// Set AdminPage Tab 
			sessionStorage.setItem("adminPage_activeTab", "integrations");
			window.location.replace(`${APP_BASE}/dispatch/admin?qb=${status}`);
			return;
		}

		try {
			const channel = new BroadcastChannel("qb-oauth");
			channel.postMessage({ type: "qb-oauth", status });
			channel.close();
		} catch {
			// BroadcastChannel unsupported — the opener still refetches on focus.
		}

		window.close();
		// If the browser refused to close us, show a manual-close message.
		const t = window.setTimeout(() => setShowFallback(true), 400);
		return () => window.clearTimeout(t);
	}, [status]);

	const connected = status === "connected";

	return (
		<div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
			<p className="text-sm font-medium text-text-primary">
				{connected ? "QuickBooks connected" : "QuickBooks connection failed"}
			</p>
			<p className="text-sm text-text-muted">
				{showFallback
					? "You can close this window."
					: "Finishing up…"}
			</p>
		</div>
	);
}
