/**
 * Core types for the agent tool layer.
 *
 * This layer exists so that an AI agent — whether it arrives over MCP from an
 * external client, or from the in-app assistant panel — has exactly one
 * definition of "what can be done to this system, and by whom". Both transports
 * are thin adapters over the registry in `registry.ts`; neither is allowed its
 * own idea of what a tool is or who may call it.
 *
 * Nothing here talks to a model. The whole layer is synchronous, typed, and
 * unit-testable without an API key.
 */

import type { z } from "zod";
import type { getScopedDb } from "../lib/context.js";

/** The org-scoped Prisma client a handler receives. The only DB handle a tool gets. */
export type ScopedDb = ReturnType<typeof getScopedDb>;

/**
 * How much damage a tool can do, and therefore what has to be true before it
 * runs. Classification is per-tool and checked in `execute.ts` against the
 * caller's policy — a tool cannot opt itself out.
 *
 * - `read`        no side effects; safe to run without confirmation.
 * - `write`       creates or mutates a record. Reversible by a human.
 * - `destructive` irreversible or outward-facing (deletes, client emails,
 *                 issuing an invoice). Never runs without explicit approval,
 *                 regardless of what the model asked for.
 */
export type RiskClass = "read" | "write" | "destructive";

/** Which transport a call arrived on. Recorded on every audit row. */
export type AgentSurface = "mcp" | "assistant";

/**
 * The resolved identity an agent acts as.
 *
 * `permissions` is NOT the raw JWT claim — it is the user's permissions already
 * intersected with the agent ceiling (see `policy.ts`). By the time a context
 * exists, the ceiling has been applied; nothing downstream needs to remember to
 * apply it.
 */
export interface AgentContext {
	/** The human this agent is acting for. Never the agent itself. */
	userId: string;
	/** The human's role, verbatim from the token: dispatcher | technician | admin. */
	role: string;
	organizationId: string;
	/** Effective permissions: user permissions ∩ agent ceiling. Already resolved. */
	permissions: readonly string[];
	/** Audit actor bucket for the human — drives `logActivity` grouping. */
	actorType: "dispatcher" | "technician";
	surface: AgentSurface;
	/** Display name for audit rows, resolved once at context build time. */
	userName?: string;
	ipAddress?: string;
	userAgent?: string;
}

/**
 * What this caller is allowed to attempt, independent of their permissions.
 *
 * Permissions answer "may this user touch jobs?"; policy answers "may an agent
 * acting for them write at all?". Both must pass. Phase 1 ships reads only, so
 * the default denies writes outright and a write tool registered by mistake
 * fails closed rather than executing.
 */
export interface AgentPolicy {
	allowWrites: boolean;
	/** Even when true, destructive tools still require `approved` on the call. */
	allowDestructive: boolean;
	/** The permission ceiling applied when the context was built. */
	ceiling: ReadonlySet<string>;
}

/** Machine-readable failure codes. Mirrors `types/responses.ts` where they overlap. */
export const AgentErrorCodes = {
	UNKNOWN_TOOL: "UNKNOWN_TOOL",
	FORBIDDEN: "FORBIDDEN",
	POLICY_DENIED: "POLICY_DENIED",
	APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
	VALIDATION_ERROR: "VALIDATION_ERROR",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	SERVER_ERROR: "SERVER_ERROR",
} as const;

export type AgentErrorCode = (typeof AgentErrorCodes)[keyof typeof AgentErrorCodes];

/**
 * Thrown by a handler that wants to fail with a specific, model-readable code
 * rather than an opaque 500. `execute.ts` maps it straight through.
 *
 * Use it for conditions the handler alone can detect — a per-type permission
 * check, a domain precondition — not for things the input schema should have
 * caught, which belong in Zod.
 */
export class AgentToolError extends Error {
	constructor(
		public readonly code: AgentErrorCode,
		message: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentToolError";
	}
}

/**
 * Every tool call returns one of these — success or failure, never a thrown
 * exception. A model that receives a structured failure can correct itself; a
 * thrown error just ends the turn.
 */
export type ToolResult =
	| {
			ok: true;
			data: unknown;
			meta?: {
				count?: number;
				/** True when results were cut to fit a context budget. */
				truncated?: boolean;
				/** Cache keys the caller should invalidate. Consumed by the assistant UI. */
				invalidates?: string[];
			};
	  }
	| {
			ok: false;
			error: {
				code: AgentErrorCode;
				message: string;
				/** Field-level detail for validation failures, so the model can retry precisely. */
				details?: unknown;
			};
	  };

/** Arguments handed to a tool handler. A handler gets nothing else — no `req`, no unscoped db. */
export interface ToolHandlerArgs<I> {
	input: I;
	ctx: AgentContext;
	/** Pre-scoped to `ctx.organizationId`. There is no path to an unscoped client. */
	db: ScopedDb;
}

/**
 * A registered tool.
 *
 * `permissions` uses ANY-OF semantics, matching `requireAnyPermission` in
 * `lib/requirePermissions.ts` — the shape every route in this codebase already
 * uses. An empty array is rejected at registration time: a tool with no
 * permission requirement is almost always an oversight, and the registry will
 * not let one exist.
 */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
	/** Snake-case, stable. This string is what the model sees and what audit rows record. */
	name: string;
	/** Short human label for UI surfaces (assistant tool cards, MCP client listings). */
	title: string;
	/**
	 * Written for the model, not for a developer. Say what it returns and when
	 * to reach for it over a neighbouring tool — most tool-selection mistakes
	 * are description problems, not model problems.
	 */
	description: string;
	risk: RiskClass;
	/**
	 * Whether a human must approve each call before it runs.
	 *
	 * Defaults to `risk === "destructive"`. Set it explicitly when the default is
	 * wrong for a particular tool: `propose_draft` writes, but what it writes is
	 * a draft a person then reviews in the UI, so gating it would be asking for
	 * the same approval twice. A destructive tool may never set this to false —
	 * the registry rejects that at boot.
	 */
	requiresApproval?: boolean;
	/** ANY-OF. Must be non-empty. */
	permissions: readonly string[];
	input: S;
	handler: (args: ToolHandlerArgs<z.infer<S>>) => Promise<unknown>;
	/**
	 * Cache keys this tool's success invalidates, for the assistant UI to feed
	 * into TanStack Query. Reads omit it.
	 */
	invalidates?: (input: z.infer<S>, result: unknown) => string[];
	/** Audit descriptor for write/destructive tools. Reads are not written to the `log` table. */
	audit?: (input: z.infer<S>, result: unknown) => {
		event_type: string;
		action: string;
		entity_type: string;
		entity_id: string;
		reason?: string;
	} | null;
}

/** A tool erased of its schema generic, as stored in the registry. */
export type AnyToolDefinition = ToolDefinition<z.ZodType>;
