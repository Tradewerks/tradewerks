import { ErrorCodes, httpError } from "../types/responses.js";

export const badRequest = (message: string) =>
	httpError(400, ErrorCodes.BAD_REQUEST, message);

export const isUniqueViolation = (err: unknown) =>
	(err as { code?: string })?.code === "P2002";
