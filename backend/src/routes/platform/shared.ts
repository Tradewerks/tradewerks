import type { Request } from "express";
import { z } from "zod";
import { ErrorCodes, httpError } from "../../types/responses.js";
import { platformAuthLimiter } from "../../platform/rateLimit.js";
import {
	requirePlatformEnabled,
	restrictPlatformIps,
	verifyStaffToken,
} from "../../platform/verifyStaffToken.js";

export const gate = [requirePlatformEnabled, restrictPlatformIps];
export const open = [...gate, platformAuthLimiter];
export const staff = [...gate, verifyStaffToken];

export const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
	const r = schema.safeParse(body);
	if (!r.success)
		throw httpError(
			400,
			ErrorCodes.VALIDATION_ERROR,
			r.error.issues[0]?.message ?? "Invalid input",
		);
	return r.data;
};
export const param = (req: Request, name: string) => req.params[name] as string;
export const bearer = (req: Request) =>
	req.headers.authorization?.split(" ")[1] ?? "";
export const actor = (req: Request) => ({
	id: req.staff!.id,
	name: req.staff!.name,
});
export const email = z.string().trim().email().max(254);
export const name = z.string().trim().min(1).max(120);
export const reason = z
	.string()
	.trim()
	.min(3, "Give a reason (3 characters or more)")
	.max(500);
export const note = z
	.string()
	.trim()
	.min(3, "Add a note (3 characters or more)")
	.max(500);
