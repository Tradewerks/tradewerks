import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useEntitlements } from "../../hooks/useEntitlements";
import { moduleForPath } from "../../lib/moduleRoutes";
import { moduleState } from "../../lib/permissionAccess";
import NotInPlanPage from "./NotInPlanPage";
import ReadOnlyModuleBanner from "./ReadOnlyModuleBanner";
import { useTranslation } from "react-i18next";

export default function ModuleRouteGuard({ children, home }: { children: ReactNode; home: string }) {
	const { t } = useTranslation();
	const { pathname } = useLocation();
	const { data } = useEntitlements();
	const route = moduleForPath(pathname);
	if (!route) return <>{children}</>;
	const state = moduleState(data, route.module);
	if (state === "on") return <>{children}</>;
	const def = data?.modules.find((m) => m.key === route.module);
	// Names come from the server's registry; the technician-side ones are keyed here, the rest fall back to it.
	const label = t(`modules.${route.module}.label`, { defaultValue: def?.label ?? route.module });
	const description = def?.description
		? t(`modules.${route.module}.description`, { defaultValue: def.description })
		: undefined;
	if (state === "not_in_plan")
		return <NotInPlanPage label={label} description={description} home={home} />;
	// Off by the org: existing records stay reachable from old links, read-only.
	if (route.kind !== "detail") return <Navigate to={home} replace />;
	return (
		<>
			<ReadOnlyModuleBanner label={label} />
			{children}
		</>
	);
}
