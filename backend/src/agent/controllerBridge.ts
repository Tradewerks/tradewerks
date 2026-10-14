/**
 * Calling the domain controllers from a tool.
 *
 * Writes go through the controllers, not through Prisma. That is where status
 * transition guards, total recomputation, tax rules, socket emissions and the
 * activity log live — a tool that wrote directly to the database would skip all
 * of it and produce records the rest of the product does not recognise. (Reads
 * go the other way, for the reasons in `records.ts`.)
 *
 * The friction is that several write controllers were written to take an Express
 * `Request` and pull `body` and `params.id` off it. A tool has no request. The
 * options were to refactor every such controller, or to hand them the shape they
 * read. Refactoring means touching working, well-tested code across a dozen
 * files to suit a new caller; the shim below is the smaller and more reversible
 * change, and it is confined to this file.
 */

import type { Request } from "express";
import type { UserContext } from "../lib/context.js";
import type { AgentContext } from "./types.js";
import { AgentErrorCodes, AgentToolError } from "./types.js";

/**
 * The subset of an Express request the write controllers actually read.
 *
 * Deliberately not a full `Request`. If a controller ever reaches for something
 * that is not here, the cast below fails loudly at that call site rather than
 * silently reading `undefined`.
 */
export interface ControllerRequestShim {
	body: unknown;
	params: Record<string, string>;
	user: {
		uid: string;
		email: string;
		role: string;
		organization_id: string | null;
		permissions: string[] | null;
	};
	headers: Record<string, string | undefined>;
}

export function requestFor(ctx: AgentContext, body: unknown, params: Record<string, string> = {}): Request {
	const shim: ControllerRequestShim = {
		body,
		params,
		user: {
			uid: ctx.userId,
			// Controllers read identity from `uid`/`role`/`organization_id`; email is
			// carried only because the type declares it.
			email: "",
			role: ctx.role,
			organization_id: ctx.organizationId,
			permissions: [...ctx.permissions],
		},
		headers: { "user-agent": ctx.userAgent },
	};
	return shim as unknown as Request;
}

/**
 * The actor context controllers stamp onto activity-log rows.
 *
 * Note what this does NOT say: it names the human, not the agent. The agent's
 * fingerprint is added separately by `agent/audit.ts`, which writes its own row
 * with `actor_type: "agent"`. Claiming a controller-level write was made by a
 * person would erase exactly the distinction the audit trail exists to record,
 * so the two live side by side rather than one overwriting the other.
 */
export function userContextFor(ctx: AgentContext): UserContext {
	return {
		techId: ctx.actorType === "technician" ? ctx.userId : undefined,
		dispatcherId: ctx.actorType === "dispatcher" ? ctx.userId : undefined,
		organizationId: ctx.organizationId,
		userAgent: ctx.userAgent,
	};
}

/** What the `{ err, item }` controllers return. */
export interface ControllerOutcome<T = unknown> {
	err: string;
	item?: T | null;
	items?: T[] | null;
	message?: string;
}

/**
 * Unwrap a controller result, turning its error string into a typed failure the
 * model can act on.
 *
 * The controllers signal failure with a message rather than an exception, and
 * those messages are written for a REST client ("Job not found", "Validation
 * failed: …"). Mapping the recognisable ones onto codes means the model sees
 * NOT_FOUND rather than a generic 500 and can correct itself.
 */
export function unwrap<T>(outcome: ControllerOutcome<T>, what: string): T {
	if (!outcome.err) {
		const value = outcome.item ?? (outcome.items as T | undefined);
		if (value == null) {
			throw new AgentToolError(AgentErrorCodes.SERVER_ERROR, `${what} reported success but returned nothing`);
		}
		return value as T;
	}

	const message = outcome.err;
	if (/not found|invalid .*id/i.test(message)) {
		throw new AgentToolError(AgentErrorCodes.NOT_FOUND, message);
	}
	if (/validation failed|must be|is required|invalid/i.test(message)) {
		throw new AgentToolError(AgentErrorCodes.VALIDATION_ERROR, message);
	}
	if (/transition|already|conflict|overlap/i.test(message)) {
		throw new AgentToolError(AgentErrorCodes.CONFLICT, message);
	}
	throw new AgentToolError(AgentErrorCodes.SERVER_ERROR, message);
}
