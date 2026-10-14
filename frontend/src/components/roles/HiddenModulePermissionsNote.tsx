import { PERMISSION_CATALOGS } from "../../lib/permissionCatalogs";
import { isPermissionOffered, type EntitlementsData } from "../../lib/permissionAccess";
import { joinLabels } from "../../lib/moduleGroups";

export default function HiddenModulePermissionsNote({
	baseTier,
	entitlements,
	keeps = false,
}: {
	baseTier: "dispatcher" | "technician";
	entitlements: EntitlementsData | undefined;
	keeps?: boolean;
}) {
	if (!entitlements) return null;
	const hidden = new Set<string>();
	for (const group of PERMISSION_CATALOGS[baseTier]) {
		for (const permission of group.permissions) {
			if (!isPermissionOffered(permission.id, entitlements)) {
				hidden.add(entitlements.permissionMap[permission.id].module);
			}
		}
	}
	const labels = entitlements.modules.filter((m) => hidden.has(m.key)).map((m) => m.label);
	if (labels.length === 0) return null;
	return (
		<p className="rounded border border-border-subtle bg-surface px-3 py-2 text-xs text-text-muted">
			Permissions for {joinLabels(labels)} are hidden while{" "}
			{labels.length === 1 ? "that module is" : "those modules are"} off or not in
			your subscription.{keeps && " The role keeps any it already has."}
		</p>
	);
}
