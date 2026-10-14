import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface PlatformStaff {
	id: string;
	email: string;
	name: string;
}

interface PlatformAuthState {
	token: string | null;
	staff: PlatformStaff | null;
	/** Why the last session ended, shown once on the sign-in page. */
	notice: "expired" | null;
	signIn: (token: string, staff: PlatformStaff) => void;
	signOut: (reason?: "expired") => void;
}

export const usePlatformAuth = create<PlatformAuthState>()(
	persist(
		(set) => ({
			token: null,
			staff: null,
			notice: null,
			signIn: (token, staff) => set({ token, staff, notice: null }),
			signOut: (reason) =>
				set({ token: null, staff: null, notice: reason ?? null }),
		}),
		{ name: "platform-auth", storage: createJSONStorage(() => sessionStorage) }
	)
);

export function isStaffTokenExpired(token: string | null): boolean {
	if (!token) return true;
	try {
		const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(atob(part));
		return typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now();
	} catch {
		return true;
	}
}
