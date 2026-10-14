import { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { APP_BASE } from "./config";

// Two separate bundles share this entry: the marketing landing page at "/" and the
// app under APP_BASE. Each is split out so a landing visitor never downloads the app
// (or its global stylesheet), and vice versa.
const LandingPage = lazy(() => import("./pages/LandingPage"));
const AppRoot = lazy(() => import("./AppRoot"));

// Public marketing pages beside the landing page; each rides the landing stylesheet.
const MARKETING_PAGES: Record<string, ReturnType<typeof lazy>> = {
	"/terms": lazy(() => import("./components/landing/legal/TermsPage")),
	"/privacy": lazy(() => import("./components/landing/legal/PrivacyPage")),
};

const { pathname, search, hash } = window.location;
const inApp = pathname === APP_BASE || pathname.startsWith(`${APP_BASE}/`);
const MarketingPage = MARKETING_PAGES[pathname.replace(/\/$/, "")];

if (pathname !== "/" && !inApp && !MarketingPage) {
	// Pre-APP_BASE URLs — bookmarks, links in emails already sent, OAuth/SSO return
	// URLs configured before the move — land on the same page inside the app.
	window.location.replace(`${APP_BASE}${pathname}${search}${hash}`);
} else {
	ReactDOM.createRoot(document.getElementById("root")!).render(
		<Suspense fallback={null}>{inApp ? <AppRoot /> : MarketingPage ? <MarketingPage /> : <LandingPage />}</Suspense>
	);
}
