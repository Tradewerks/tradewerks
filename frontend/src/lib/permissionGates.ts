type PermissionHolder = { role: string; permissions: string[] } | null | undefined;

/** Either document view grant lets a dispatcher see that kind's disputes. */
export const DISPUTE_VIEW_PERMISSIONS = ["view_quotes", "view_invoices"] as const;

/** Admin clears every gate, matching the backend's resolvePerms. */
export const hasAnyPermission = (
	user: PermissionHolder,
	permissions: readonly string[],
): boolean =>
	!!user && (user.role === "admin" || permissions.some((p) => user.permissions.includes(p)));

interface WidgetGate {
	requiredPermission?: string;
	requiredAnyPermission?: readonly string[];
}

/** One rule for the Widgets picker and the grid, so a widget the picker hides can't still render. */
export const canSeeWidget = (user: PermissionHolder, entry: WidgetGate | undefined): boolean => {
	if (!entry) return false;
	if (entry.requiredPermission && !hasAnyPermission(user, [entry.requiredPermission])) return false;
	if (entry.requiredAnyPermission && !hasAnyPermission(user, entry.requiredAnyPermission)) return false;
	return true;
};
