import { describe, it, expect, vi, beforeEach } from "vitest";

const { orgFindUnique, orgUpdate, groupUpdateMany, notifyTaxCodeNeeds } = vi.hoisted(() => ({
	orgFindUnique: vi.fn(),
	orgUpdate: vi.fn(),
	groupUpdateMany: vi.fn(),
	notifyTaxCodeNeeds: vi.fn(),
}));
vi.mock("intuit-oauth", () => ({
	default: class {
		static scopes = { Accounting: "accounting" };
		createToken = vi.fn(async () => ({
			getJson: () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
		}));
	},
}));
vi.mock("../appLogger.js", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/context.js", () => {
	const tx = { organization: { update: orgUpdate }, tax_group: { updateMany: groupUpdateMany } };
	return {
		getScopedDb: () => ({
			organization: { findUnique: orgFindUnique },
			$transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
		}),
	};
});
vi.mock("../qb/qbConnectTaxGuard.js", async (orig) => ({
	...(await orig<typeof import("../qb/qbConnectTaxGuard.js")>()),
	notifyTaxCodeNeeds,
}));

import { handleCallback, handleCallbackRequest } from "../quickbooksService.js";
import { signQbOAuthState } from "../qb/qbOAuthState.js";

process.env.JWT_ACCESS_SECRET = "test-access-secret";

beforeEach(() => {
	vi.clearAllMocks();
	groupUpdateMany.mockResolvedValue({ count: 2 });
	notifyTaxCodeNeeds.mockResolvedValue(undefined);
});

describe("handleCallback tax code guard", () => {
	it("keeps tax code links when reconnecting the same company", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: "r1", qb_passthrough_tax_code_id: "7" });
		await handleCallback("https://x/cb?code=c", "org-1", "r1");
		const data = orgUpdate.mock.calls[0][0].data;
		expect(data.qb_tax_codes_realm_id).toBe("r1");
		expect("qb_passthrough_tax_code_id" in data).toBe(false);
		expect(groupUpdateMany).not.toHaveBeenCalled();
		expect(notifyTaxCodeNeeds).toHaveBeenCalledWith("org-1", false);
	});

	it("clears the pass-through code and group links when the company changes", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: "r1", qb_passthrough_tax_code_id: "7" });
		await handleCallback("https://x/cb?code=c", "org-1", "r2");
		const data = orgUpdate.mock.calls[0][0].data;
		expect(data).toMatchObject({ qb_realm_id: "r2", qb_tax_codes_realm_id: "r2", qb_passthrough_tax_code_id: null });
		expect(groupUpdateMany).toHaveBeenCalledWith({
			where: { organization_id: "org-1", qb_tax_code_id: { not: null } },
			data: { qb_tax_code_id: null },
		});
		expect(notifyTaxCodeNeeds).toHaveBeenCalledWith("org-1", true);
	});

	it("does not report an unlink when the old company had no codes", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: "r1", qb_passthrough_tax_code_id: null });
		groupUpdateMany.mockResolvedValue({ count: 0 });
		await handleCallback("https://x/cb?code=c", "org-1", "r2");
		expect(notifyTaxCodeNeeds).toHaveBeenCalledWith("org-1", false);
	});

	it("clears codes held by an org stamped unknown (disconnected at migration time)", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: "unknown", qb_passthrough_tax_code_id: "7" });
		await handleCallback("https://x/cb?code=c", "org-1", "r1");
		const data = orgUpdate.mock.calls[0][0].data;
		expect(groupUpdateMany).toHaveBeenCalled();
		expect(data).toMatchObject({ qb_passthrough_tax_code_id: null, qb_tax_codes_realm_id: "r1" });
		expect(notifyTaxCodeNeeds).toHaveBeenCalledWith("org-1", true);
	});

	it("treats a first connection as the same company", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: null, qb_passthrough_tax_code_id: null });
		await handleCallback("https://x/cb?code=c", "org-1", "r1");
		expect(groupUpdateMany).not.toHaveBeenCalled();
		expect(orgUpdate.mock.calls[0][0].data.qb_tax_codes_realm_id).toBe("r1");
	});
});

describe("handleCallbackRequest state check", () => {
	it("callback refuses an unsigned state", async () => {
		const outcome = await handleCallbackRequest({ state: "org-1", realmId: "r1" }, "https://x/cb?code=c");
		expect(outcome).toBe("error");
		expect(orgFindUnique).not.toHaveBeenCalled();
		expect(orgUpdate).not.toHaveBeenCalled();
	});

	it.each([undefined, "", ["r1", "r2"]])("refuses a signed callback with realmId %j", async (realmId) => {
		const state = signQbOAuthState("org-9", "u1");
		const outcome = await handleCallbackRequest({ state, realmId }, "https://x/cb?code=c");
		expect(outcome).toBe("error");
		expect(orgUpdate).not.toHaveBeenCalled();
		expect(groupUpdateMany).not.toHaveBeenCalled();
	});

	it("connects the org named in a signed state", async () => {
		orgFindUnique.mockResolvedValue({ qb_tax_codes_realm_id: null, qb_passthrough_tax_code_id: null });
		const state = signQbOAuthState("org-9", "u1");
		const outcome = await handleCallbackRequest({ state, realmId: "r1" }, "https://x/cb?code=c");
		expect(outcome).toBe("connected");
		expect(orgUpdate.mock.calls[0][0].where).toEqual({ id: "org-9" });
	});
});
