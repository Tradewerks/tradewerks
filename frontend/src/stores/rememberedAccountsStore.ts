import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RememberedAccount {
	userId: string;
	name: string; 
	email: string;
	role: "dispatcher" | "technician" | "admin";
	orgId: string | null;
	orgName?: string | null;
	lastUsedAt: number;
}

const MAX_ACCOUNTS = 5;

// Email is the identity here, not userId: a row only pre-fills the login form, and the same
// email comes back under a new id after a reseed or a delete and re-invite.
const uniqueByEmail = (accounts: RememberedAccount[]) => {
	const seen = new Set<string>();
	return [...accounts]
		.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
		.filter((a) => {
			const email = a.email.toLowerCase();
			if (seen.has(email)) return false;
			seen.add(email);
			return true;
		})
		.slice(0, MAX_ACCOUNTS);
};

interface RememberedAccountsState {
	accounts: RememberedAccount[];
	upsertAccount: (account: Omit<RememberedAccount, "lastUsedAt">) => void;
	patchAccount: (userId: string, patch: Partial<Omit<RememberedAccount, "userId">>) => void;
	removeAccount: (userId: string) => void;
	clearAccounts: () => void;
}

export const useRememberedAccountsStore = create<RememberedAccountsState>()(
	persist(
		(set) => ({
			accounts: [],
			upsertAccount: (account) =>
				set((state) => ({
					accounts: uniqueByEmail([
						{ ...account, lastUsedAt: Date.now() },
						...state.accounts.filter((a) => a.userId !== account.userId),
					]),
				})),
			patchAccount: (userId, patch) =>
				set((state) => ({
					accounts: state.accounts.map((a) =>
						a.userId === userId ? { ...a, ...patch } : a,
					),
				})),
			removeAccount: (userId) =>
				set((state) => ({
					accounts: state.accounts.filter((a) => a.userId !== userId),
				})),
			clearAccounts: () => set({ accounts: [] }),
		}),
		{
			name: "remembered-accounts",
			// On every load rather than a one-shot migrate: another open tab writes back its
			// in-memory list, which can restore rows a migration already removed.
			merge: (persisted, current) => ({
				...current,
				accounts: uniqueByEmail(
					(persisted as Partial<RememberedAccountsState>).accounts ?? [],
				),
			}),
		},
	),
);
