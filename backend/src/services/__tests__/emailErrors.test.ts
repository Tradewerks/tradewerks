import { describe, it, expect } from "vitest";
import { translateSendError, isSendFailure } from "../emailErrors.js";

/**
 * Postmark rejects a send with a paragraph written for whoever administers the
 * account, not for the dispatcher who pressed Email to Client. It names the
 * sending domain, the recipient's domain and the account's approval state — a
 * dispatcher can act on none of it, and it reads as though the system broke.
 *
 * translateSendError is the single place that decides what leaves the server.
 */
describe("translateSendError", () => {
	// The account-restriction case that prompted this: a new Postmark server may
	// only mail its own domain until the account is approved.
	it("turns the pending-approval rejection into an administrator-facing message", () => {
		const err = translateSendError(
			Object.assign(new Error(
				"While your account is pending approval, all recipient addresses must share the same domain as the 'From' address. The domain of the 'From' address is 'epicitautomations.com', but you are attempting to send email to the following domain(s): 'gmail.com'.",
			), { code: 405, statusCode: 422 }),
		);

		expect(err.code).toBe("EMAIL_SEND_FAILED");
		expect(err.status).toBe(502);
		expect(err.message).not.toContain("pending approval");
		expect(err.message).not.toContain("gmail.com");
		expect(err.message).toMatch(/administrator/i);
	});

	// Kept off the wire but not lost: the operator message is useless for
	// diagnosis, so the original stays on the error for the structured log.
	it("preserves the provider text for logging", () => {
		const err = translateSendError(
			Object.assign(new Error("Sender signature not confirmed"), { code: 403 }),
		);

		expect(err.providerMessage).toBe("Sender signature not confirmed");
	});

	// An unverified From address fails for a different reason with a different
	// fix, but neither is the dispatcher's to make, so both read the same way.
	it("treats an unconfirmed sender signature as the same class of failure", () => {
		const err = translateSendError(
			Object.assign(new Error("Sender signature not confirmed"), { code: 403 }),
		);

		expect(err.code).toBe("EMAIL_SEND_FAILED");
		expect(err.status).toBe(502);
	});

	// A bad recipient address IS the dispatcher's to fix, so it must not be
	// flattened into "contact your administrator" — that sends them to the wrong
	// person for a typo they can correct themselves.
	it("keeps an inactive or invalid recipient actionable by the sender", () => {
		const err = translateSendError(
			Object.assign(new Error("You tried to send to a recipient that has been marked as inactive."), {
				code: 406,
			}),
		);

		expect(err.code).toBe("EMAIL_RECIPIENT_REJECTED");
		expect(err.status).toBe(422);
		expect(err.message).toMatch(/address/i);
	});

	// Anything unrecognised must still not pass the provider's wording through.
	it("falls back to a generic failure without echoing the provider", () => {
		const err = translateSendError(new Error("socket hang up"));

		expect(err.code).toBe("EMAIL_SEND_FAILED");
		expect(err.message).not.toContain("socket hang up");
		expect(err.providerMessage).toBe("socket hang up");
	});
});

/**
 * The send routes use this to decide whether a thrown message is safe to return.
 * A false positive would put a stack-trace string in front of a dispatcher.
 */
describe("isSendFailure", () => {
	it("accepts what translateSendError produces", () => {
		expect(isSendFailure(translateSendError(new Error("boom")))).toBe(true);
	});

	it("rejects a plain Error", () => {
		expect(isSendFailure(new Error("PDF render failed"))).toBe(false);
	});

	// The half-shaped case is the dangerous one: an error carrying a code but no
	// translated message would otherwise be trusted.
	it("rejects an Error carrying only some of the fields", () => {
		expect(
			isSendFailure(
				Object.assign(new Error("nope"), { code: "EMAIL_SEND_FAILED" }),
			),
		).toBe(false);
		expect(
			isSendFailure(
				Object.assign(new Error("nope"), { code: "EMAIL_SEND_FAILED", status: 502 }),
			),
		).toBe(false);
	});

	it("rejects non-Errors", () => {
		for (const v of [null, undefined, "string", 42, {}]) {
			expect(isSendFailure(v)).toBe(false);
		}
	});
});
