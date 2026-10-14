import { describe, it, expect } from "vitest";
import { jobActions, JOB_STEPS, isJobOffRamp } from "../jobActions";
import { splitActions } from "../overflow";
import { JobStatusValues } from "../../../types/jobs";
import type { JobStatus } from "../../../types/jobs";

const noop = () => {};
const handlers = { scheduleVisit: noop, invoice: noop, cancel: noop };

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "Scheduled" as JobStatus,
	visitCount: 2,
	openVisitCount: 1,
	canEdit: true,
	canCreateVisit: true,
	canCreateInvoice: true,
	handlers,
	...over,
});

describe("job path", () => {
	it("keeps the four happy-path steps in order", () => {
		expect(JOB_STEPS).toEqual(["Unscheduled", "Scheduled", "InProgress", "Completed"]);
	});

	it("treats only Cancelled as an off-ramp", () => {
		expect(isJobOffRamp("Cancelled")).toBe(true);
		expect(isJobOffRamp("Completed")).toBe(false);
	});
});

describe("jobActions", () => {
	it("offers the same actions in the same order in every status", () => {
		const ids = jobActions(ctx()).map((a) => a.id);
		expect(ids).toEqual(["scheduleVisit", "invoice", "cancel"]);

		for (const status of JobStatusValues) {
			expect(jobActions(ctx({ status })).map((a) => a.id)).toEqual(ids);
		}
	});

	it("gives every disabled action a reason, in every status", () => {
		for (const status of JobStatusValues) {
			for (const a of jobActions(ctx({ status }))) {
				if (a.disabled) {
					expect(a.disabledReason, `${status}/${a.id}`).toBeTruthy();
				}
			}
		}
	});

	it("never puts the destructive action in the visible row", () => {
		for (const status of JobStatusValues) {
			const { inline } = splitActions("normal", jobActions(ctx({ status })));
			expect(inline.some((a) => a.intent === "destructive")).toBe(false);
		}
	});

	/**
	 * A job's status is recomputed from its visits by the backend. Any action
	 * that writes job.status directly would be overwritten on the next visit
	 * write, so the catalog must not offer one.
	 */
	it("offers no action that sets the job status directly", () => {
		const ids = jobActions(ctx()).map((a) => a.id);
		expect(ids).not.toContain("markComplete");
		expect(ids).not.toContain("start");
		expect(ids).not.toContain("complete");
	});

	it("refuses to invoice a job with no visits", () => {
		const invoice = jobActions(ctx({ status: "Unscheduled", visitCount: 0 }))[1];
		expect(invoice.disabled).toBe(true);
		expect(invoice.disabledReason).toMatch(/no visits/i);
	});

	it("refuses to cancel a job that is already finished", () => {
		for (const status of ["Completed", "Cancelled"] as JobStatus[]) {
			const cancel = jobActions(ctx({ status }))[2];
			expect(cancel.disabled).toBe(true);
		}
	});

	it("refuses each action without the matching permission", () => {
		const [visit, invoice, cancel] = jobActions(
			ctx({ canEdit: false, canCreateVisit: false, canCreateInvoice: false })
		);
		for (const a of [visit, invoice, cancel]) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/permission/i);
		}
	});
});
