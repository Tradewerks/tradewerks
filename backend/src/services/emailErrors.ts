import { ErrorCodes, type ErrorCode } from "../types/responses.js";

/**
 * A delivery failure, restated for the person who pressed Send.
 *
 * `message` is what reaches the caller; `providerMessage` is the original, kept
 * for the structured log and never returned over the wire.
 */
export interface SendFailure extends Error {
	code: ErrorCode;
	status: number;
	providerMessage: string;
}

// Postmark API error codes. 406 is the recipient's own state (inactive after a
// hard bounce or a spam complaint); 300 is a malformed address. Both are the
// sender's to fix. Everything else about a rejected send is the account's.
const RECIPIENT_CODES = new Set([300, 406]);

const RECIPIENT_PATTERNS = [/inactive/i, /invalid email/i, /recipient/i];

/**
 * Restate a provider rejection as something the caller can act on.
 *
 * The provider writes for whoever administers the email account: its text names
 * the sending domain, the recipient's domain and the account's approval state.
 * A dispatcher can act on none of that, and it reads as though the system
 * broke. This is the single place that decides what leaves the server, so the
 * provider's wording cannot reach a client by being re-thrown somewhere new.
 */
export function translateSendError(err: unknown): SendFailure {
	const raw = err as { message?: string; code?: unknown } | null | undefined;
	const providerMessage = raw?.message ?? "unknown email provider error";
	const providerCode = typeof raw?.code === "number" ? raw.code : null;

	const isRecipientFault =
		(providerCode !== null && RECIPIENT_CODES.has(providerCode)) ||
		(providerCode === null &&
			RECIPIENT_PATTERNS.some((p) => p.test(providerMessage)));

	const failure = new Error(
		isRecipientFault
			? "That email address was rejected. Check the address and try again."
			: "Email could not be sent. Email sending is not enabled for this account — contact your administrator.",
	) as SendFailure;

	failure.code = isRecipientFault
		? ErrorCodes.EMAIL_RECIPIENT_REJECTED
		: ErrorCodes.EMAIL_SEND_FAILED;
	// 502, not 500: the failure is downstream, and the distinction is what tells
	// an on-call engineer this is not our process falling over.
	failure.status = isRecipientFault ? 422 : 502;
	failure.providerMessage = providerMessage;
	return failure;
}

/**
 * Whether a thrown value came from translateSendError.
 *
 * Only a translated failure carries a message written for the caller. Everything
 * else a send can throw — a PDF render error, a Prisma error, a socket hangup —
 * carries text that was never meant to leave the server, so the send routes use
 * this to decide whether `message` is safe to return.
 */
export function isSendFailure(e: unknown): e is SendFailure {
	if (!(e instanceof Error)) return false;
	const candidate = e as Partial<SendFailure>;
	return (
		typeof candidate.code === "string" &&
		typeof candidate.status === "number" &&
		typeof candidate.providerMessage === "string"
	);
}
