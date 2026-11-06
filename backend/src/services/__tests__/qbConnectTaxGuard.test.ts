import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique, getQBTaxPrefs, notifyDispatchers } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	getQBTaxPrefs: vi.fn(),
	notifyDispatchers: vi.fn(),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: () => ({ organization: { findUnique } }),
}));
vi.mock("../qb/qbTax.js", () => ({ getQBTaxPrefs }));
vi.mock("../../controllers/notificationsController.js", () => ({ notifyDispatchers }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { log } from "../appLogger.js";
import { isDifferentCompany, notifyTaxCodeNeeds } from "../qb/qbConnectTaxGuard.js";

const URL = "/dispatch/admin?tab=integrations";

beforeEach(() => {
	vi.clearAllMocks();
	getQBTaxPrefs.mockResolvedValue({ automatedSalesTax: false });
	notifyDispatchers.mockResolvedValue([]);
});

describe("isDifferentCompany", () => {
	it.each([
		[null, "r1", false],
		["r1", "r1", false],
		["r1", "r2", true],
	])("%s → %s = %s", (prev, next, want) => {
		expect(isDifferentCompany(prev as string | null, next as string)).toBe(want);
	});
});

describe("notifyTaxCodeNeeds", () => {
	it("prompts for a pass-through code when auto has none and the company is not AST", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: null });
		await notifyTaxCodeNeeds("org-1", false);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_tax_code_needed",
				title: "Choose a QuickBooks tax code for automatic tax",
				body: "Automatic tax is on, but no pass-through tax code is set. Until one is chosen, QuickBooks calculates its own tax on pushed invoices.",
				actionUrl: URL,
			},
			"org-1",
		);
	});

	it("stays quiet for an AST company", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: null });
		getQBTaxPrefs.mockResolvedValue({ automatedSalesTax: true });
		await notifyTaxCodeNeeds("org-1", false);
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("does not ask QuickBooks when a pass-through code is already set", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: "7" });
		await notifyTaxCodeNeeds("org-1", false);
		expect(getQBTaxPrefs).not.toHaveBeenCalled();
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("treats an unreadable AST preference as non-AST", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: null });
		getQBTaxPrefs.mockRejectedValue(new Error("401"));
		await notifyTaxCodeNeeds("org-1", false);
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
	});

	it("tells a manual org its links were removed after a company change", async () => {
		findUnique.mockResolvedValue({ tax_mode: "manual", qb_passthrough_tax_code_id: null });
		await notifyTaxCodeNeeds("org-1", true);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_tax_code_needed",
				title: "QuickBooks tax codes need relinking",
				body: "This is a different QuickBooks company, so tax code links from the previous one were removed. Link your tax groups to this company's tax codes.",
				actionUrl: URL,
			},
			"org-1",
		);
	});

	it("says both when auto lost its code to a company change", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: null });
		await notifyTaxCodeNeeds("org-1", true);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Choose a QuickBooks tax code for automatic tax",
				body: "This is a different QuickBooks company, so tax code links from the previous one were removed. Automatic tax is on, but no pass-through tax code is set. Until one is chosen, QuickBooks calculates its own tax on pushed invoices.",
			}),
			"org-1",
		);
	});

	it("is silent for a manual org with nothing unlinked", async () => {
		findUnique.mockResolvedValue({ tax_mode: "manual", qb_passthrough_tax_code_id: null });
		await notifyTaxCodeNeeds("org-1", false);
		expect(getQBTaxPrefs).not.toHaveBeenCalled();
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("never throws: a failed notification is logged", async () => {
		findUnique.mockResolvedValue({ tax_mode: "auto", qb_passthrough_tax_code_id: null });
		notifyDispatchers.mockRejectedValue(new Error("db down"));
		await expect(notifyTaxCodeNeeds("org-1", false)).resolves.toBeUndefined();
		expect(log.error).toHaveBeenCalled();
	});
});
