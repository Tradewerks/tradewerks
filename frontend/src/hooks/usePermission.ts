import { useAuthStore } from "../auth/authStore";
import { isPermissionEffective } from "../lib/permissionAccess";
import { useEntitlements } from "./useEntitlements";

export const usePermission = (permission: string) => {
	const user = useAuthStore((s) => s.user);
	const { data } = useEntitlements();
	if (!user) return false;
	return user.permissions.includes(permission) && isPermissionEffective(permission, data);
};

export const useAnyPermission = (permissions: string[]) => {
	const user = useAuthStore((s) => s.user);
	const { data } = useEntitlements();
	if (!user) return false;
	return permissions.some(
		(perm) => user.permissions.includes(perm) && isPermissionEffective(perm, data),
	);
};
