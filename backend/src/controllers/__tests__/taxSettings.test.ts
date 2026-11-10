import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, orgCtx, logActivity } = vi.hoisted(() => {
	const lines = () => ({ count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 0 })) });
	const dbMock: any = {
		organization: {
			findUnique: vi.fn(async () => ({ tax_mode: "manual", tax_registered_states: [], address: "1 Shop Rd, Verona, WI 53593" })),
			update: vi.fn(async () => ({})),
		},
		tax_group: { findMany: vi.fn(async () => [{ id: "g-def" }]) },
		client: { findMany: vi.fn(async () => [{ id: "c7", tax_group_id: "g-cli" }]) },
		quote_line_item: lines(),
		job_line_item: lines(),
		job_visit_line_item: lines(),
		invoice_line_item: lines(),
		quote: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
		job: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
		job_visit: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
		invoice: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
	};
	dbMock.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock));
	return { dbMock, orgCtx: vi.fn(), logActivity: vi.fn(async () => undefined) };
});
const { qbPrefs, recompute, appLog } = vi.hoisted(() => ({
	qbPrefs: vi.fn(async () => ({ automatedSalesTax: false })),
	recompute: vi.fn(async (): Promise<unknown> => ({ ok: true })),
	appLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../db.js", () => ({ db: dbMock }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => dbMock) }));
vi.mock("../../services/tax/taxMode.js", () => ({ getOrgTaxContext: orgCtx }));
vi.mock("../../services/logger.js", () => ({ logActivity }));
vi.mock("../../services/qb/qbTax.js", () => ({ getQBTaxPrefs: qbPrefs }));
vi.mock("../../services/appLogger.js", () => ({ log: appLog }));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({ recomputeDocumentTotals: recompute }));

import {
	getTaxSettings,
	previewAutoSwitch,
	refreshDraftsAfterAutoSwitch,
	setQBPassthroughTaxCode,
	updateTaxSettings,
} from "../taxSettingsController.js";
import { updateTaxSettingsSchema } from "../../lib/validate/tax.js";

const ctx = (over: Record<string, unknown> = {}) => ({
	stored_mode: "manual",
	auto_entitled: true,
	mode: "manual",
	registered_states: [],
	legacy_rate: 0,
	address: "1 Shop Rd, Verona, WI 53593",
	...over,
});

describe("updateTaxSettingsSchema", () => {
	it("accepts known USPS codes, upper-cases, dedupes and sorts", () => {
		expect(updateTaxSettingsSchema.parse({ tax_registered_states: ["wi", "IL", "WI"] })).toEqual({
			tax_registered_states: ["IL", "WI"],
		});
	});
	it("rejects unknown codes, state names, an unknown mode and an empty body", () => {
		expect(() => updateTaxSettingsSchema.parse({ tax_registered_states: ["ZZ"] })).toThrow();
		expect(() => updateTaxSettingsSchema.parse({ tax_registered_states: ["Wisconsin"] })).toThrow();
		expect(() => updateTaxSettingsSchema.parse({ tax_mode: "avalara" })).toThrow();
		expect(() => updateTaxSettingsSchema.parse({})).toThrow();
	});
});

describe("tax settings controller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(ctx());
		dbMock.organization.findUnique.mockResolvedValue({
			tax_mode: "manual",
			qb_realm_id: null,
			qb_passthrough_tax_code_id: null,
		});
	});

	it("GET reports stored vs effective mode, entitlement and the org's state", async () => {
		orgCtx.mockResolvedValueOnce(ctx({ stored_mode: "auto", auto_entitled: false, mode: "manual" }));
		expect(await getTaxSettings("org1")).toEqual({
			tax_mode: "auto",
			effective_tax_mode: "manual",
			auto_entitled: false,
			tax_registered_states: [],
			org_state: "WI",
			qb_passthrough_required: false,
			legacy_rate: 0,
		});
		expect(qbPrefs).not.toHaveBeenCalled();
	});

	it("GET returns the org flat rate for the no-fallback warning", async () => {
		orgCtx.mockResolvedValueOnce(ctx({ legacy_rate: 0.065 }));
		expect((await getTaxSettings("org1")).legacy_rate).toBe(0.065);
	});

	it("GET flags a connected QuickBooks company with no pass-through code, without calling QuickBooks", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({
			qb_realm_id: "realm1",
			qb_passthrough_tax_code_id: null,
		});
		expect((await getTaxSettings("org1")).qb_passthrough_required).toBe(true);
		expect(qbPrefs).not.toHaveBeenCalled();
	});

	it("refuses auto without the tax_auto module", async () => {
		orgCtx.mockResolvedValueOnce(ctx({ auto_entitled: false }));
		const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
		expect(r).toEqual({ ok: false, code: "NOT_IN_PLAN", message: expect.stringMatching(/Automated Tax/) });
		expect(dbMock.organization.update).not.toHaveBeenCalled();
	});

	it("refuses an empty states list while auto is on and writes nothing", async () => {
		orgCtx.mockResolvedValue(
			ctx({
				stored_mode: "auto",
				mode: "auto",
				registered_states: ["WI"],
			}),
		);
		const r = await updateTaxSettings(
			"org1",
			{ tax_registered_states: [] },
			"d1",
		);
		expect(r).toEqual({
			ok: false,
			code: "VALIDATION",
			message:
				"Automatic tax needs at least one state where you collect sales tax.",
		});
		expect(dbMock.organization.update).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("allows an empty states list in manual mode", async () => {
		orgCtx.mockResolvedValue(
			ctx({ stored_mode: "manual", registered_states: ["WI"] }),
		);
		const r = await updateTaxSettings(
			"org1",
			{ tax_registered_states: [] },
			"d1",
		);
		expect(r.ok).toBe(true);
	});

	it("refuses switching to auto with an explicit empty list", async () => {
		orgCtx.mockResolvedValue(ctx({ stored_mode: "manual" }));
		const r = await updateTaxSettings(
			"org1",
			{ tax_mode: "auto", tax_registered_states: [] },
			"d1",
		);
		expect(r).toMatchObject({ ok: false, code: "VALIDATION" });
	});

	it("PUT with only primary_pack is an empty update and writes nothing", async () => {
		const r = await updateTaxSettings("org1", { primary_pack: "hvac" }, "d1");
		expect(r).toMatchObject({ ok: false, code: "VALIDATION" });
		expect(dbMock.organization.update).not.toHaveBeenCalled();
	});

	it("PUT ignores a primary_pack sent beside a real change", async () => {
		const r = await updateTaxSettings("org1", { tax_registered_states: ["WI"], primary_pack: "hvac" }, "d1");
		expect(r.ok).toBe(true);
		expect(dbMock.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { tax_registered_states: ["WI"] },
		});
	});

	it("manual → auto clears org-default and client-default groups on draft lines and seeds the org's state", async () => {
		dbMock.quote_line_item.updateMany.mockResolvedValueOnce({ count: 3 });
		dbMock.job_line_item.updateMany.mockResolvedValueOnce({ count: 2 });
		orgCtx
			.mockResolvedValueOnce(ctx())
			.mockResolvedValueOnce(ctx({ stored_mode: "auto", mode: "auto", registered_states: ["WI"] }));

		const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");

		expect(dbMock.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { tax_mode: "auto", tax_registered_states: ["WI"] },
		});
		expect(dbMock.tax_group.findMany).toHaveBeenCalledWith({
			where: { is_default: true, is_active: true },
			select: { id: true },
		});
		// A client's own default group is cleared only on that client's documents.
		expect(dbMock.quote_line_item.updateMany).toHaveBeenCalledWith({
			where: {
				quote: { organization_id: "org1", status: "Draft" },
				OR: [
					{ tax_group_id: { in: ["g-def"] } },
					{ tax_group_id: "g-cli", quote: { client_id: { in: ["c7"] } } },
				],
			},
			data: { tax_group_id: null },
		});
		expect(dbMock.job_visit_line_item.updateMany).toHaveBeenCalledWith({
			where: {
				visit: { status: { notIn: ["Completed", "Cancelled"] }, job: { organization_id: "org1" } },
				OR: [
					{ tax_group_id: { in: ["g-def"] } },
					{ tax_group_id: "g-cli", visit: { job: { client_id: { in: ["c7"] } } } },
				],
			},
			data: { tax_group_id: null },
		});
		expect(r).toMatchObject({ ok: true, item: { tax_mode: "auto", cleared_default_lines: 5 } });
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "organization.tax_settings_updated", entity_id: "org1", actor_id: "d1" }),
		);
	});

	describe("QuickBooks pass-through prerequisite", () => {
		const PASSTHROUGH_NEEDED =
			"Choose a QuickBooks pass-through tax code before turning on automated tax.";
		const qbOrg = (over: Record<string, unknown> = {}) => ({
			tax_mode: "manual",
			qb_realm_id: "realm1",
			qb_passthrough_tax_code_id: null,
			...over,
		});

		it("refuses auto for a non-AST company with no pass-through code and writes nothing", async () => {
			dbMock.organization.findUnique.mockResolvedValue(qbOrg());
			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
			expect(r).toEqual({ ok: false, code: "CONFLICT", message: PASSTHROUGH_NEEDED });
			expect(dbMock.$transaction).not.toHaveBeenCalled();
			expect(dbMock.organization.update).not.toHaveBeenCalled();
			expect(logActivity).not.toHaveBeenCalled();
		});

		it("allows auto for an AST company with no pass-through code", async () => {
			dbMock.organization.findUnique.mockResolvedValue(qbOrg());
			qbPrefs.mockResolvedValueOnce({ automatedSalesTax: true });
			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
			expect(r.ok).toBe(true);
			expect(dbMock.organization.update).toHaveBeenCalled();
		});

		it("refuses auto when the QuickBooks preference cannot be read", async () => {
			dbMock.organization.findUnique.mockResolvedValue(qbOrg());
			qbPrefs.mockRejectedValueOnce(new Error("QB down"));
			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
			expect(r).toEqual({ ok: false, code: "CONFLICT", message: PASSTHROUGH_NEEDED });
			expect(dbMock.organization.update).not.toHaveBeenCalled();
		});

		it("allows auto without a QuickBooks connection", async () => {
			dbMock.organization.findUnique.mockResolvedValue(qbOrg({ qb_realm_id: null }));
			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
			expect(r.ok).toBe(true);
			expect(qbPrefs).not.toHaveBeenCalled();
		});

		it("does not ask QuickBooks when a pass-through code is already set", async () => {
			dbMock.organization.findUnique.mockResolvedValue(
				qbOrg({ qb_passthrough_tax_code_id: "99" }),
			);
			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");
			expect(r.ok).toBe(true);
			expect(qbPrefs).not.toHaveBeenCalled();
		});

		it("refuses clearing the pass-through code while auto is on (non-AST)", async () => {
			dbMock.organization.findUnique.mockResolvedValue(
				qbOrg({ tax_mode: "auto", qb_passthrough_tax_code_id: "99" }),
			);
			const r = await setQBPassthroughTaxCode("org1", null);
			expect(r).toEqual({
				ok: false,
				code: "CONFLICT",
				message: "Turn off automated tax before removing the pass-through tax code.",
			});
			expect(dbMock.organization.update).not.toHaveBeenCalled();
		});

		it("allows clearing the pass-through code while auto is on for an AST company", async () => {
			dbMock.organization.findUnique.mockResolvedValue(
				qbOrg({ tax_mode: "auto", qb_passthrough_tax_code_id: "99" }),
			);
			dbMock.organization.update.mockResolvedValueOnce({ qb_passthrough_tax_code_id: null });
			qbPrefs.mockResolvedValueOnce({ automatedSalesTax: true });
			const r = await setQBPassthroughTaxCode("org1", null);
			expect(r).toEqual({ ok: true, item: { passthroughTaxCodeId: null } });
		});

		it("allows clearing the pass-through code in manual mode without asking QuickBooks", async () => {
			dbMock.organization.findUnique.mockResolvedValue(
				qbOrg({ qb_passthrough_tax_code_id: "99" }),
			);
			dbMock.organization.update.mockResolvedValueOnce({ qb_passthrough_tax_code_id: null });
			const r = await setQBPassthroughTaxCode("org1", null);
			expect(r).toEqual({ ok: true, item: { passthroughTaxCodeId: null } });
			expect(dbMock.organization.update).toHaveBeenCalledWith({
				where: { id: "org1" },
				data: { qb_passthrough_tax_code_id: null },
				select: { qb_passthrough_tax_code_id: true },
			});
			expect(qbPrefs).not.toHaveBeenCalled();
		});

		it("sets a pass-through code in auto mode without asking QuickBooks", async () => {
			dbMock.organization.findUnique.mockResolvedValue(qbOrg({ tax_mode: "auto" }));
			dbMock.organization.update.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "42" });
			const r = await setQBPassthroughTaxCode("org1", "42");
			expect(r).toEqual({ ok: true, item: { passthroughTaxCodeId: "42" } });
			expect(qbPrefs).not.toHaveBeenCalled();
		});
	});

	describe("recompute of the drafts the switch cleared", () => {
		it("collects the affected drafts before clearing and queues them after commit", async () => {
			dbMock.job.findMany.mockResolvedValueOnce([{ id: "j1" }]);
			dbMock.job_visit.findMany.mockResolvedValueOnce([{ id: "v1" }]);
			dbMock.invoice.findMany.mockResolvedValueOnce([{ id: "i1" }]);
			const order: string[] = [];
			dbMock.quote.findMany.mockImplementationOnce(async () => {
				order.push("collect");
				return [{ id: "q1" }, { id: "q2" }];
			});
			dbMock.quote_line_item.updateMany.mockImplementationOnce(async () => {
				order.push("clear");
				return { count: 0 };
			});
			logActivity.mockImplementationOnce(async () => {
				order.push("log");
			});
			recompute.mockImplementation(async () => {
				order.push("recompute");
				return { ok: true };
			});

			const r = await updateTaxSettings("org1", { tax_mode: "auto" }, "d1");

			expect(r).toMatchObject({ ok: true, item: { recompute_queued: 5 } });
			// Same document filter as the preview's draft count.
			expect(dbMock.job_visit.findMany).toHaveBeenCalledWith({
				where: {
					status: { notIn: ["Completed", "Cancelled"] },
					job: { organization_id: "org1" },
					line_items: {
						some: {
							OR: [
								{ tax_group_id: { in: ["g-def"] } },
								{ tax_group_id: "g-cli", visit: { job: { client_id: { in: ["c7"] } } } },
							],
						},
					},
				},
				select: { id: true },
			});
			await vi.waitFor(() => expect(recompute).toHaveBeenCalledTimes(5));
			expect(order.indexOf("collect")).toBeLessThan(order.indexOf("clear"));
			expect(order.indexOf("log")).toBeLessThan(order.indexOf("recompute"));
			recompute.mockReset();
			recompute.mockResolvedValue({ ok: true });
		});

		it("queues nothing when not switching to auto", async () => {
			const r = await updateTaxSettings("org1", { tax_registered_states: ["WI"] }, "d1");
			expect(r).toMatchObject({ ok: true, item: { recompute_queued: 0 } });
			expect(dbMock.quote.findMany).not.toHaveBeenCalled();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(recompute).not.toHaveBeenCalled();
		});

		it("recomputes jobs, then visits, then quotes, then invoices, one at a time", async () => {
			let inFlight = 0;
			let maxInFlight = 0;
			recompute.mockImplementation(async () => {
				maxInFlight = Math.max(maxInFlight, ++inFlight);
				await new Promise((resolve) => setTimeout(resolve, 0));
				inFlight--;
				return { ok: true };
			});

			await refreshDraftsAfterAutoSwitch("org1", {
				quote: ["q1"],
				job: ["j1", "j2"],
				job_visit: ["v1"],
				invoice: ["i1"],
			});

			expect(recompute.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([
				["job", "j1"],
				["job", "j2"],
				["job_visit", "v1"],
				["quote", "q1"],
				["invoice", "i1"],
			]);
			expect(recompute.mock.calls[0][2]).toBe("org1");
			expect(dbMock.$transaction).toHaveBeenCalledTimes(5);
			expect(maxInFlight).toBe(1);
			recompute.mockReset();
			recompute.mockResolvedValue({ ok: true });
		});

		it("logs a failing document and carries on; a locked one is skipped silently", async () => {
			recompute
				.mockRejectedValueOnce(new Error("boom"))
				.mockResolvedValueOnce({ ok: false, reason: "locked" })
				.mockResolvedValueOnce({ ok: true });

			await refreshDraftsAfterAutoSwitch("org1", {
				quote: ["q1"],
				job: ["j1"],
				job_visit: [],
				invoice: ["i1"],
			});

			expect(recompute).toHaveBeenCalledTimes(3);
			expect(appLog.error).toHaveBeenCalledTimes(1);
			expect(appLog.error).toHaveBeenCalledWith(
				expect.objectContaining({ orgId: "org1", model: "job", id: "j1" }),
				expect.any(String),
			);
		});
	});

	it("does not clear lines when the mode does not change", async () => {
		await updateTaxSettings("org1", { tax_registered_states: ["WI", "MN"] }, "d1");
		expect(dbMock.quote_line_item.updateMany).not.toHaveBeenCalled();
		expect(dbMock.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { tax_registered_states: ["MN", "WI"] },
		});
	});

	it("previews the lines a switch would clear, with the same filters", async () => {
		dbMock.quote_line_item.count.mockResolvedValueOnce(4);
		dbMock.invoice_line_item.count.mockResolvedValueOnce(1);
		dbMock.quote.count.mockResolvedValueOnce(2);
		dbMock.invoice.count.mockResolvedValueOnce(1);
		expect(await previewAutoSwitch("org1")).toEqual({
			default_group_lines: 5,
			quote_lines: 4,
			job_lines: 0,
			visit_lines: 0,
			invoice_lines: 1,
			default_group_drafts: 3,
			quote_drafts: 2,
			job_drafts: 0,
			visit_drafts: 0,
			invoice_drafts: 1,
		});
		// Document counts reuse the exact line OR, so "N drafts" matches the lines cleared.
		expect(dbMock.invoice.count).toHaveBeenCalledWith({
			where: {
				organization_id: "org1",
				status: "Draft",
				line_items: {
					some: {
						OR: [
							{ tax_group_id: { in: ["g-def"] } },
							{ tax_group_id: "g-cli", invoice: { client_id: { in: ["c7"] } } },
						],
					},
				},
			},
		});
		expect(dbMock.job_visit.count).toHaveBeenCalledWith({
			where: {
				status: { notIn: ["Completed", "Cancelled"] },
				job: { organization_id: "org1" },
				line_items: {
					some: {
						OR: [
							{ tax_group_id: { in: ["g-def"] } },
							{ tax_group_id: "g-cli", visit: { job: { client_id: { in: ["c7"] } } } },
						],
					},
				},
			},
		});
		expect(dbMock.invoice_line_item.count).toHaveBeenCalledWith({
			where: {
				invoice: { organization_id: "org1", status: "Draft" },
				OR: [
					{ tax_group_id: { in: ["g-def"] } },
					{ tax_group_id: "g-cli", invoice: { client_id: { in: ["c7"] } } },
				],
			},
		});
	});

	it("previews and clears nothing when there is no org default and no client group", async () => {
		dbMock.tax_group.findMany.mockResolvedValueOnce([]);
		dbMock.client.findMany.mockResolvedValueOnce([]);
		expect((await previewAutoSwitch("org1")).default_group_lines).toBe(0);
		expect(dbMock.quote_line_item.count).not.toHaveBeenCalled();
		expect(dbMock.quote.count).not.toHaveBeenCalled();
		expect((await previewAutoSwitch("org1")).default_group_drafts).toBe(0);
	});
});
