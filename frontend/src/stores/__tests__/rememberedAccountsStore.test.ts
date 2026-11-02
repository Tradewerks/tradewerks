import { beforeEach, describe, expect, it } from "vitest";
import { useRememberedAccountsStore } from "../rememberedAccountsStore";

const account = (userId: string, email: string) => ({
	userId,
	email,
	name: email.split("@")[0],
	role: "dispatcher" as const,
	orgId: `org-${userId}`,
});

const stored = (userId: string, email: string, lastUsedAt: number) => ({
	...account(userId, email),
	lastUsedAt,
});

const seedStorage = (accounts: ReturnType<typeof stored>[]) =>
	localStorage.setItem(
		"remembered-accounts",
		JSON.stringify({ state: { accounts }, version: 0 }),
	);

const accounts = () => useRememberedAccountsStore.getState().accounts;

describe("rememberedAccountsStore", () => {
	beforeEach(() => {
		localStorage.clear();
		useRememberedAccountsStore.setState({ accounts: [] });
	});

	it("replaces the old row when the same email returns under a new user id", () => {
		const { upsertAccount } = useRememberedAccountsStore.getState();
		upsertAccount(account("old-id", "admin@epichvac.com"));
		upsertAccount(account("new-id", "admin@epichvac.com"));

		expect(accounts().map((a) => a.userId)).toEqual(["new-id"]);
	});

	it("treats emails differing only by case as one account", () => {
		const { upsertAccount } = useRememberedAccountsStore.getState();
		upsertAccount(account("a", "Admin@EpicHVAC.com"));
		upsertAccount(account("b", "admin@epichvac.com"));

		expect(accounts()).toHaveLength(1);
	});

	it("keeps accounts with the same local part at different domains", () => {
		const { upsertAccount } = useRememberedAccountsStore.getState();
		upsertAccount(account("a", "owner@bluepipe.test"));
		upsertAccount(account("b", "owner@greenleaf.test"));

		expect(accounts()).toHaveLength(2);
	});

	it("collapses duplicates already in storage to the most recently used row", async () => {
		seedStorage([
			stored("oldest", "admin@epichvac.com", 100),
			stored("newest", "admin@epichvac.com", 300),
			stored("other", "dispatcher@epichvac.com", 200),
		]);

		await useRememberedAccountsStore.persist.rehydrate();

		expect(accounts().map((a) => a.userId)).toEqual(["newest", "other"]);
	});

	it("starts empty when storage holds nothing", async () => {
		await useRememberedAccountsStore.persist.rehydrate();

		expect(accounts()).toEqual([]);
	});
});
