import { lazy, useEffect, type ReactElement } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { isStaffTokenExpired, usePlatformAuth } from "./store";
import PlatformShell from "./PlatformShell";

const LoginPage = lazy(() => import("./pages/LoginPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const InvitePage = lazy(() => import("./pages/InvitePage"));
const EnrollPage = lazy(() => import("./pages/EnrollPage"));
const OrgsPage = lazy(() => import("./pages/OrgsPage"));
const OrgDetailPage = lazy(() => import("./pages/OrgDetailPage"));
const TiersPage = lazy(() => import("./pages/TiersPage"));
const TierDetailPage = lazy(() => import("./pages/TierDetailPage"));
const RequestsPage = lazy(() => import("./pages/RequestsPage"));
const StaffPage = lazy(() => import("./pages/StaffPage"));

function RequireStaff({ children }: { children: ReactElement }) {
	const token = usePlatformAuth((s) => s.token);
	const location = useLocation();
	const expired = isStaffTokenExpired(token);
	useEffect(() => {
		if (expired && token) usePlatformAuth.getState().signOut("expired");
	}, [expired, token]);
	if (expired)
		return (
			<Navigate
				to="/platform/login"
				replace
				state={{ from: location.pathname + location.search }}
			/>
		);
	return children;
}

export default function PlatformRoutes() {
	const qc = useQueryClient();
	// Every sign-out path (button, 401, expiry) drops the previous session's back-office data.
	useEffect(
		() =>
			usePlatformAuth.subscribe((s, prev) => {
				if (prev.token && !s.token)
					qc.removeQueries({ queryKey: ["platform"] });
			}),
		[qc]
	);
	return (
		<Routes>
			<Route path="login" element={<LoginPage />} />
			<Route path="setup" element={<SetupPage />} />
			<Route path="invite" element={<InvitePage />} />
			<Route path="enroll" element={<EnrollPage />} />
			<Route
				element={
					<RequireStaff>
						<PlatformShell />
					</RequireStaff>
				}
			>
				<Route index element={<Navigate to="orgs" replace />} />
				<Route path="orgs" element={<OrgsPage />} />
				<Route path="orgs/:orgId" element={<OrgDetailPage />} />
				<Route path="tiers" element={<TiersPage />} />
				<Route path="tiers/:tierKey" element={<TierDetailPage />} />
				<Route path="requests" element={<RequestsPage />} />
				<Route path="staff" element={<StaffPage />} />
			</Route>
			<Route path="*" element={<Navigate to="/platform" replace />} />
		</Routes>
	);
}
