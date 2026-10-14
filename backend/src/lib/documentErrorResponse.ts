import { ErrorCodes, createErrorResponse } from "../types/responses.js";

/**
 * One status-mapping policy for the document write paths: turn a service's
 * `{ err }` result into an HTTP status and error body, keyed on explicit flags
 * rather than sniffing the message text. `conflict` is a lost race (409),
 * `notFound` a missing document (404), anything else a rule refusal (422).
 *
 * `disputeErrorResponse` (disputesController) is the dispute-specific superset
 * that also handles `forbidden`.
 */
export function documentErrorResponse(result: {
	err: string;
	conflict?: boolean;
	notFound?: boolean;
}) {
	if (result.conflict) {
		return {
			status: 409,
			body: createErrorResponse(ErrorCodes.CONFLICT, result.err),
		};
	}
	if (result.notFound) {
		return {
			status: 404,
			body: createErrorResponse(ErrorCodes.NOT_FOUND, result.err),
		};
	}
	return {
		status: 422,
		body: createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err),
	};
}
