import { describe, it, expect } from "vitest";
import {
	requestActions,
	REQUEST_STEPS,
	isRequestOffRamp,
	isRequestTerminalOffRamp,
	isRequestNonTerminalOffRamp,
	REQUEST_TERMINAL_OFF_RAMPS,
} from "../requestActions";
import { splitActions } from "../overflow";
import { RequestStatusValues } from "../../../types/requests";
import type { RequestStatus } from "../../../types/requests";

const noop = () => {};
const handlers = { review: noop, quote: noop, job: noop, cancel: noop };

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "New" as RequestStatus,
	hasQuote: false,
	hasJob: false,
	autoAdvancePending: false,
	canEdit: true,
	canCreateQuote: true,
	canCreateJob: true,
	handlers,
	...over,
});

describe("request path", () => {
	it("keeps the four happy-path steps in order", () => {
		expect(REQUEST_STEPS).toEqual(["New", "Reviewing", "Quoted", "QuoteApproved"]);
	});

	it("treats the three non-path statuses as off-ramps", () => {
		expect(isRequestOffRamp("QuoteRejected")).toBe(true);
		expect(isRequestOffRamp("ConvertedToJob")).toBe(true);
		expect(isRequestOffRamp("Cancelled")).toBe(true);
		expect(isRequestOffRamp("Quoted")).toBe(false);
	});
});

describe("requestActions", () => {
	it("offers the same actions in the same order in every status", () => {
		const ids = requestActions(ctx()).map((a) => a.id);
		expect(ids).toEqual(["review", "quote", "job", "cancel"]);

		for (const status of RequestStatusValues) {
			expect(requestActions(ctx({ status })).map((a) => a.id)).toEqual(ids);
		}
	});

	it("gives every disabled action a reason, in every status", () => {
		for (const status of RequestStatusValues) {
			for (const a of requestActions(ctx({ status }))) {
				if (a.disabled) {
					expect(a.disabledReason, `${status}/${a.id}`).toBeTruthy();
				}
			}
		}
	});

	it("never puts the destructive action in the visible row", () => {
		for (const status of RequestStatusValues) {
			const { inline } = splitActions("normal", requestActions(ctx({ status })));
			expect(inline.some((a) => a.intent === "destructive")).toBe(false);
		}
	});

	/**
	 * The page auto-advances New to Reviewing five seconds after load. An
	 * enabled Mark as Reviewing during that window races the timer and issues
	 * a second write, so it is shut with a reason that names the automation
	 * rather than looking arbitrarily broken.
	 */
	it("shuts Mark as Reviewing while the auto-advance timer is armed", () => {
		const [review] = requestActions(ctx({ status: "New", autoAdvancePending: true }));
		expect(review.disabled).toBe(true);
		expect(review.disabledReason).toMatch(/automatically/i);
	});

	it("explains an illegal transition by naming the status", () => {
		const [review] = requestActions(ctx({ status: "ConvertedToJob" }));
		expect(review.disabled).toBe(true);
		expect(review.disabledReason).toMatch(/converted to job/i);
	});

	it("says a quote already exists rather than offering a second one", () => {
		const quote = requestActions(ctx({ status: "Quoted", hasQuote: true }))[1];
		expect(quote.label).toBe("Quote Already Created");
		expect(quote.disabled).toBe(true);
	});

	it("refuses every action without the matching permission", () => {
		const [review, quote, job] = requestActions(
			ctx({ canEdit: false, canCreateQuote: false, canCreateJob: false })
		);
		for (const a of [review, quote, job]) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/permission/i);
		}
	});
});

describe("request terminal vs off-ramp", () => {
	/**
	 * The page was computing `stage` from isRequestOffRamp, which is a wider
	 * set: a request whose quote was rejected can still be re-quoted or
	 * converted, and the page was telling the dispatcher it was over.
	 */
	it("treats only ConvertedToJob and Cancelled as terminal off-ramps", () => {
		expect(isRequestTerminalOffRamp("ConvertedToJob")).toBe(true);
		expect(isRequestTerminalOffRamp("Cancelled")).toBe(true);
		expect(isRequestTerminalOffRamp("QuoteRejected")).toBe(false);
		expect(isRequestTerminalOffRamp("New")).toBe(false);
	});

	// The predicate was never wrong about what an off-ramp is — only the stage
	// computation was wrong to read it as terminal.
	it("keeps QuoteRejected an off-ramp", () => {
		expect(isRequestOffRamp("QuoteRejected")).toBe(true);
	});

	it("makes every terminal status an off-ramp too", () => {
		for (const status of REQUEST_TERMINAL_OFF_RAMPS) {
			expect(isRequestOffRamp(status)).toBe(true);
		}
	});
});

describe("isRequestNonTerminalOffRamp", () => {
	// The set the pages actually gate on: off the happy path, but with a live
	// exit still in the bar's action row. Table test over every status so a
	// future addition to REQUEST_OFF_RAMPS or REQUEST_TERMINAL_OFF_RAMPS
	// can't drift this predicate out of step silently.
	it("accepts exactly the non-terminal off-ramps and rejects everything else", () => {
		for (const status of RequestStatusValues) {
			const expected = status === "QuoteRejected";
			expect(isRequestNonTerminalOffRamp(status)).toBe(expected);
		}
	});
});
describe("requestActions hidden actions", () => {
	const byId = (over: Record<string, unknown>) =>
		Object.fromEntries(requestActions(ctx(over)).map((a) => [a.id, a]));

	it("hides actions the request has already moved past", () => {
		const a = byId({ status: "Reviewing", hasQuote: true });
		expect(a.review.hidden).toBe(true);
		expect(a.quote.hidden).toBe(true);
		expect(a.job.hidden).toBeFalsy();
	});

	it("keeps a permission-blocked action visible and disabled", () => {
		const a = byId({ canCreateJob: false });
		expect(a.job.disabled).toBe(true);
		expect(a.job.hidden).toBeFalsy();
	});

	it("keeps the pending auto-advance visible", () => {
		expect(byId({ autoAdvancePending: true }).review.hidden).toBeFalsy();
	});
});
