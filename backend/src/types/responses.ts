export interface ApiResponse<T = unknown> {
	success: boolean;
	data: T | null;
	error: ErrorDetails | null;
	meta?: ResponseMeta;
}

export interface ErrorDetails {
	code: string;
	message: string;
	details?: unknown;
	field?: string;
}

//Optional metadata for responses
export interface ResponseMeta {
	timestamp?: string;
	count?: number;
	hasMore?: boolean;
	total?: number;
	page?: number;
	pageSize?: number;
}

export interface ControllerResult<T = unknown> {
	err: string;
	item?: T | null;
	message?: string;
}

export const ErrorCodes = {
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	CONFLICT: 'CONFLICT',
	INVALID_INPUT: 'INVALID_INPUT',
	DELETE_ERROR: 'DELETE_ERROR',
	SERVER_ERROR: 'SERVER_ERROR',
	INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
	INVALID_TOKEN: 'INVALID_TOKEN',
	TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
	FORBIDDEN: 'FORBIDDEN',
	// Its own code because the UI answers it differently from any other 403:
	// the action is not closed to this person, it is closed to them ON THIS
	// dispute, and the fix is to hand it to a colleague.
	SELF_RESOLUTION_FORBIDDEN: 'SELF_RESOLUTION_FORBIDDEN',
	BAD_REQUEST: 'BAD_REQUEST',
	// Delivery failed for a reason the sender cannot fix — the email account is
	// unapproved, its sending domain unverified, the provider unreachable. Its
	// own code because the UI answers it differently from a validation error:
	// nothing about the document is wrong, and retrying changes nothing until
	// an administrator acts.
	EMAIL_SEND_FAILED: 'EMAIL_SEND_FAILED',
	// Delivery failed on the address itself, which IS the sender's to fix.
	// Separate from EMAIL_SEND_FAILED so a typo does not send them to an
	// administrator.
	EMAIL_RECIPIENT_REJECTED: 'EMAIL_RECIPIENT_REJECTED',
	// Module gating. Separate from FORBIDDEN because the fix is not a role
	// change: MODULE_DISABLED is the org's own switch, MODULE_NOT_IN_PLAN is the plan.
	MODULE_DISABLED: 'MODULE_DISABLED',
	MODULE_NOT_IN_PLAN: 'MODULE_NOT_IN_PLAN',
	ENTITLEMENTS_UNAVAILABLE: 'ENTITLEMENTS_UNAVAILABLE',
	// Caps. Separate codes because the fix is a subscription change (or freeing
	// a seat), not a retry or a role change.
	SEAT_LIMIT_REACHED: 'SEAT_LIMIT_REACHED',
	QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
	REQUEST_OPEN: 'REQUEST_OPEN',
	REQUEST_CLOSED: 'REQUEST_CLOSED',
	// Its own code so the register page shows "paused" rather than a generic failure.
	SIGNUPS_PAUSED: 'SIGNUPS_PAUSED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export const createSuccessResponse = <T>(
	data: T,
	meta?: Partial<ResponseMeta>
): ApiResponse<T> => ({
	success: true,
	data,
	error: null,
	meta: {
		timestamp: new Date().toISOString(),
		...meta,
	},
});

export const createErrorResponse = (
	code: ErrorCode | string,
	message: string,
	details?: unknown,
	field?: string
): ApiResponse<null> => ({
	success: false,
	data: null,
	error: {
		code,
		message,
		details,
		field,
	},
	meta: {
		timestamp: new Date().toISOString(),
	},
});

// Error carrying an HTTP status + error code. The global errorHandler reads
// `statusCode` and `code` off the thrown error, so `throw httpError(...)`
// surfaces the right status instead of a blanket 500.
export interface HttpError extends Error {
	statusCode: number;
	code: ErrorCode | string;
}

export const httpError = (
	statusCode: number,
	code: ErrorCode | string,
	message: string,
): HttpError => {
	const err = new Error(message) as HttpError;
	err.statusCode = statusCode;
	err.code = code;
	return err;
};