import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
	disputeAuthzFrom,
	NO_DISPUTE_AUTHORITY,
	outcomeRefusal,
} from "../disputeAuthz.js";

const asReq = (user: Record<string, unknown> | undefined) =>
	({ user } as unknown as Request);

describe("disputeAuthzFrom", () => {
	it("reads every grant off the caller's permissions", () => {
		expect(
			disputeAuthzFrom(
				asReq({
					role: "dispatcher",
					permissions: ["resolve_disputes", "concede_disputes"],
				}),
			),
		).toEqual({ canConcede: true, canRefund: false, canResolveOwn: false });
	});

	it("grants nothing to a dispatcher holding only resolve_disputes", () => {
		expect(
			disputeAuthzFrom(
				asReq({ role: "dispatcher", permissions: ["resolve_disputes"] }),
			),
		).toEqual(NO_DISPUTE_AUTHORITY);
	});

	// resolvePerms in requirePermissions.ts short-circuits on the admin role,
	// so every route gate already passes for an admin. A concession gate that
	// read the permissions array instead would be the one place an admin is
	// refused — locking the owner out of their own write-off.
	it("gives an admin every dispute authority", () => {
		expect(disputeAuthzFrom(asReq({ role: "admin", permissions: [] }))).toEqual({
			canConcede: true,
			canRefund: true,
			canResolveOwn: true,
		});
	});

	it("gives an unauthenticated request nothing", () => {
		expect(disputeAuthzFrom(asReq(undefined))).toEqual(NO_DISPUTE_AUTHORITY);
	});
});

describe("outcomeRefusal", () => {
	const CONCEDE_ONLY = { canConcede: true, canRefund: false, canResolveOwn: false };
	const FULL = { canConcede: true, canRefund: true, canResolveOwn: false };

	// Revise & Resend corrects our own error. The client is billed the same
	// money in the end, so it is not a concession and needs no extra grant.
	it("lets Revise & Resend through without concede_disputes", () => {
		expect(
			outcomeRefusal("invoice", "ReviseAndResend", {
				...NO_DISPUTE_AUTHORITY,
				canRefund: true,
			}),
		).toBeNull();
	});

	// Revise & Resend voids the original before issuing its replacement — the
	// kebab's Void by another door (DW-06).
	it("refuses Revise & Resend on an invoice without refund_invoices", () => {
		expect(
			outcomeRefusal("invoice", "ReviseAndResend", NO_DISPUTE_AUTHORITY),
		).toBe(
			"You don't have permission to void invoices, and Revise & Resend voids this one before issuing its replacement. Ask someone with refund and void authority to resolve this dispute.",
		);
	});

	it("does not ask for refund_invoices to revise a quote", () => {
		expect(
			outcomeRefusal("quote", "ReviseAndResend", NO_DISPUTE_AUTHORITY),
		).toBeNull();
	});

	it("refuses Issue Adjustment without concede_disputes", () => {
		expect(
			outcomeRefusal("invoice", "IssueAdjustment", NO_DISPUTE_AUTHORITY),
		).toMatch(/permission/i);
	});

	it("refuses Repeal without concede_disputes", () => {
		expect(outcomeRefusal("invoice", "Repeal", NO_DISPUTE_AUTHORITY)).toMatch(
			/permission/i,
		);
	});

	it("names the outcome it refused", () => {
		expect(outcomeRefusal("invoice", "Repeal", NO_DISPUTE_AUTHORITY)).toContain(
			"Repeal",
		);
	});

	// A credit adjustment reduces what is owed; it does not send money out of
	// the bank. That is concede_disputes' job, not refund_invoices'.
	it("lets Issue Adjustment through on concede_disputes alone", () => {
		expect(outcomeRefusal("invoice", "IssueAdjustment", CONCEDE_ONLY)).toBeNull();
	});

	// Repealing an invoice writes status Void — the same act as the kebab's
	// Void, which sits behind refund_invoices. Concession authority alone must
	// not reach it, or the split leaks.
	it("refuses to repeal an invoice without refund_invoices", () => {
		expect(outcomeRefusal("invoice", "Repeal", CONCEDE_ONLY)).toMatch(/void/i);
	});

	it("allows an invoice repeal with both grants", () => {
		expect(outcomeRefusal("invoice", "Repeal", FULL)).toBeNull();
	});

	// Repealing a quote cancels an offer. No money exists to refund, so
	// demanding an invoice permission here would be a rule about nothing.
	it("does not ask for refund_invoices to repeal a quote", () => {
		expect(outcomeRefusal("quote", "Repeal", CONCEDE_ONLY)).toBeNull();
	});
});
