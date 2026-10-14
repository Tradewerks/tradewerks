import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useRememberedAccountsStore } from "../stores/rememberedAccountsStore";

interface User {
	role: "dispatcher" | "technician" | "admin";
	name: string;
	userId: string;
	orgId: string | null;
	orgTimezone: string; // IANA timezone, e.g. "America/Chicago"
	permissions: string[];
}

interface AuthState {
	user: User | null;
	_hasHydrated: boolean;
	login: (role: User["role"], name: string, userId: string, orgId: string | null, orgTimezone: string, permissions: string[]) => void;
	logout: (remember?: boolean) => void;
	setHasHydrated: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
	persist(
		(set) => ({
			user: null,
			_hasHydrated: false,
			login: (role, name, userId, orgId, orgTimezone, permissions) =>
				set({ user: { role, name, userId, orgId, orgTimezone, permissions } }),
			logout: (remember?: boolean) => {
				localStorage.removeItem("accessToken");
				// The next account on this browser must not start from this org's module state.
				localStorage.removeItem("entitlements:last");
				if (!remember) {
					useRememberedAccountsStore.getState().removeAccount(useAuthStore.getState().user?.userId || "");
				}
				set({ user: null });
			},
			setHasHydrated: (v) => set({ _hasHydrated: v }),
		}),
		{
			name: "auth-storage",
			onRehydrateStorage: () => (state) => {
				state?.setHasHydrated(true);
			},
		}
	)
);

export function isTokenExpired(): boolean {
	const token = localStorage.getItem("accessToken");
	if (!token) return true;
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return true;
		const payload = JSON.parse(atob(parts[1]));
		if (typeof payload.exp !== "number") return true;
		return payload.exp * 1000 <= Date.now();
	} catch {
		return true;
	}
}
