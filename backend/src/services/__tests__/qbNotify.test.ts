import { describe, it, expect, vi, beforeEach } from "vitest";

const { org, refreshUsingToken } = vi.hoisted(() => ({
	org: {
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	refreshUsingToken: vi.fn(),
}));

vi.mock("intuit-oauth", () => ({
	default: class {
		static scopes = { Accounting: "accounting" };
		refreshUsingToken = refreshUsingToken;
	},
}));
vi.mock("../appLogger.js", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: () => ({ organization: org }),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
}));

import { notifyQbDisconnected, notifyQbProblem } from "../qb/qbNotify.js";
import { getValidToken } from "../quickbooksService.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { log } from "../appLogger.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const invoice = { id: "inv1", invoice_number: "INV-1039" };

describe("notifyQbProblem", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		[
			"push_failed",
			"QuickBooks sync failed for Invoice INV-1039",
			"Open the invoice and choose Retry sync.",
		],
		[
			"payment_push_failed",
			"A payment on Invoice INV-1039 didn't reach QuickBooks",
			"Open the invoice and choose Retry sync.",
		],
		[
			"void_failed",
			"Invoice INV-1039 is void here but still open in QuickBooks",
			"Void the invoice in QuickBooks.",
		],
		[
			"refund_not_in_qb",
			"Invoice INV-1039: refund not in QuickBooks",
			"Record the refund in QuickBooks, then mark the invoice reconciled.",
		],
		[
			"qb_payment_delete_failed",
			"Invoice INV-1039: payment still in QuickBooks",
			"Delete the payment in QuickBooks, then mark the invoice reconciled.",
		],
		[
			"qb_payment_overapplied",
			"Invoice INV-1039: QuickBooks payment larger than the balance",
			"Check the payment in QuickBooks, then mark the invoice reconciled.",
		],
	] as const)("writes the %s copy", async (kind, title, body) => {
		await notifyQbProblem("org1", invoice, kind);

		expect(notifyDispatchers).toHaveBeenCalledWith(
			{ type: "qb_sync_failed", title, body, actionUrl: "/dispatch/invoices/inv1" },
			"org1",
		);
	});

	it("never rejects into the caller", async () => {
		mockFn(notifyDispatchers).mockRejectedValueOnce(new Error("pool exhausted"));

		await expect(notifyQbProblem("org1", invoice, "push_failed")).resolves.toBeUndefined();
		expect(log.error).toHaveBeenCalledTimes(1);
	});
});

describe("notifyQbDisconnected", () => {
	beforeEach(() => vi.clearAllMocks());

	it("never rejects into the caller", async () => {
		mockFn(notifyDispatchers).mockRejectedValueOnce(new Error("pool exhausted"));

		await expect(notifyQbDisconnected("org1")).resolves.toBeUndefined();
		expect(log.error).toHaveBeenCalledTimes(1);
	});
});

describe("expired QuickBooks grant", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		org.findUnique.mockResolvedValue({
			qb_access_token: "tok",
			qb_refresh_token: "ref",
			qb_realm_id: "realm1",
			qb_token_expires_at: new Date(Date.now() - 1000),
		});
		refreshUsingToken.mockRejectedValue({ error: "invalid_grant" });
	});

	it("an expired QuickBooks grant clears tokens and notifies qb_connection_lost once", async () => {
		// The second caller read the tokens before the first cleared them.
		org.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		await expect(getValidToken("org1")).rejects.toThrow(
			"QuickBooks authorization expired. Please reconnect.",
		);
		await expect(getValidToken("org1")).rejects.toThrow(
			"QuickBooks authorization expired. Please reconnect.",
		);

		expect(org.updateMany).toHaveBeenCalledWith({
			where: { id: "org1", qb_refresh_token: "ref" },
			data: { qb_access_token: null, qb_refresh_token: null, qb_token_expires_at: null },
		});
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_connection_lost",
				title: "QuickBooks disconnected",
				body: "Reconnect in Admin → Settings → Integrations. Nothing syncs until you do.",
				actionUrl: "/dispatch/admin?tab=integrations",
			},
			"org1",
		);
	});
});
