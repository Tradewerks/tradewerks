import { Router, type Request } from "express";
import { z } from "zod";
// SIDE-EFFECT IMPORT, load-bearing. Tools call defineTool() at module load, and
// importing agent/registry.js alone does not pull them in — so without this the
// registry is empty here, /assistant/status reports enabled:false, and the panel
// hides itself with nothing anywhere saying why. Verified by
// routes/__tests__/assistantCatalog.test.ts.
import "../agent/index.js";
import { buildAgentContext } from "../agent/context.js";
import { executeTool } from "../agent/execute.js";
import { getTool } from "../agent/registry.js";
import { READ_ONLY_POLICY, WRITE_POLICY } from "../agent/policy.js";
import { describeTools } from "../agent/registry.js";
import type { AgentContext } from "../agent/types.js";
import { getScopedDb } from "../lib/context.js";
import { consumeQuota } from "../lib/entitlements/quota.js";
import { log } from "../services/appLogger.js";
import { assistantApprovals } from "../services/metricsService.js";
import { createErrorResponse, createSuccessResponse, ErrorCodes } from "../types/responses.js";
import {
	areWritesEnabled,
	ASSISTANT_MODEL,
	assistantUnavailableReason,
	isAssistantEnabled,
	MAX_CONCURRENT_STREAMS_PER_USER,
	TURN_TIMEOUT_MS,
} from "../assistant/config.js";
import {
	archiveConversation,
	ConversationAccessError,
	createConversation,
	deriveTitle,
	getConversation,
	getPendingApproval,
	listConversations,
	listPendingApprovals,
	loadMessages,
	renameConversation,
	resolveToolCall,
	TOOL_CALL_STATUS,
} from "../assistant/conversations.js";
import { openEventStream } from "../assistant/events.js";
import { resumeTurn, runTurn } from "../assistant/loop.js";
import { AssistantNotConfiguredError } from "../assistant/openaiClient.js";
import { describeToolCall, summariseToolResult } from "../assistant/toolBridge.js";

const router = Router();

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Build the agent context for this request.
 *
 * `buildAgentContext` is what applies the permission ceiling, so every route
 * here goes through it rather than reading `req.user.permissions` directly.
 */
async function agentContextFrom(req: Request): Promise<AgentContext> {
	return buildAgentContext(
		{
			uid: req.user!.uid,
			role: req.user!.role,
			organization_id: req.user!.organization_id,
			permissions: req.user!.permissions,
		},
		"assistant",
		{ ipAddress: req.ip, userAgent: req.headers["user-agent"] },
	);
}

/**
 * The policy every route here runs under.
 *
 * One function so a route cannot accidentally construct a more permissive
 * policy than the one `/status` advertised — the panel decides what to show a
 * person from that response.
 */
const activePolicy = () => (areWritesEnabled() ? WRITE_POLICY : READ_ONLY_POLICY);

/** The org's IANA zone, so the model reasons about "today" in the right one. */
async function orgTimezone(organizationId: string): Promise<string> {
	const db = getScopedDb(organizationId);
	const org = await db.organization.findFirst({
		where: { id: organizationId },
		select: { timezone: true },
	});
	return org?.timezone || "America/Chicago";
}

/**
 * Open streams per user.
 *
 * Not a rate limiter — that is Phase 5 — but each stream drives a paid API in a
 * loop, and a retry loop in a browser tab should not be able to open dozens.
 * In-memory on purpose: it guards a single process against a single runaway
 * client, which is exactly the failure it exists for.
 */
const openStreams = new Map<string, number>();

const acquireStream = (userId: string): boolean => {
	const current = openStreams.get(userId) ?? 0;
	if (current >= MAX_CONCURRENT_STREAMS_PER_USER) return false;
	openStreams.set(userId, current + 1);
	return true;
};

const releaseStream = (userId: string): void => {
	const current = openStreams.get(userId) ?? 0;
	if (current <= 1) openStreams.delete(userId);
	else openStreams.set(userId, current - 1);
};

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * What this user can expect from the assistant.
 *
 * The frontend hides the whole feature when `enabled` is false — an assistant
 * that can only apologise is worse than no assistant.
 */
router.get("/status", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		const policy = activePolicy();
		const tools = describeTools({
			permissions: ctx.permissions,
			allowWrites: policy.allowWrites,
			allowDestructive: policy.allowDestructive,
		});

		res.json(
			createSuccessResponse({
				enabled: isAssistantEnabled() && tools.length > 0,
				reason: !isAssistantEnabled()
					? assistantUnavailableReason()
					: tools.length === 0
						? "Your permissions do not reach anything the assistant can look up."
						: null,
				model: isAssistantEnabled() ? ASSISTANT_MODEL : null,
				readOnly: !policy.allowWrites,
				toolCount: tools.length,
				tools: tools.map((t) => ({ name: t.name, title: t.title })),
			}),
		);
	} catch (err) {
		next(err);
	}
});

// ── Conversations ───────────────────────────────────────────────────────────

router.get("/conversations", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		const conversations = await listConversations(ctx);
		res.json(createSuccessResponse(conversations, { count: conversations.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/conversations", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		const conversation = await createConversation(ctx);
		res.status(201).json(createSuccessResponse(conversation));
	} catch (err) {
		next(err);
	}
});

router.get("/conversations/:id/messages", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		const messages = await loadMessages(ctx, req.params.id as string);
		res.json(createSuccessResponse(messages, { count: messages.length }));
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "No such conversation"));
		}
		next(err);
	}
});

const renameSchema = z.object({ title: z.string().min(1).max(120) });

router.patch("/conversations/:id", async (req, res, next) => {
	try {
		const parsed = renameSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "title must be 1-120 characters", parsed.error.issues));
		}
		const ctx = await agentContextFrom(req);
		const updated = await renameConversation(ctx, req.params.id as string, parsed.data.title);
		res.json(createSuccessResponse(updated));
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "No such conversation"));
		}
		next(err);
	}
});

router.delete("/conversations/:id", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		await archiveConversation(ctx, req.params.id as string);
		res.json(createSuccessResponse(null));
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "No such conversation"));
		}
		next(err);
	}
});

// ── The turn ────────────────────────────────────────────────────────────────

const streamSchema = z.object({
	message: z.string().min(1, "message is required").max(8000),
	conversation_id: z.string().uuid().optional(),
});

/**
 * POST because a turn sends a body, which EventSource cannot do — the client
 * reads the stream with fetch instead. See frontend/src/api/assistant.ts.
 */
router.post("/stream", async (req, res, next) => {
	if (!isAssistantEnabled()) {
		return res
			.status(503)
			.json(createErrorResponse(ErrorCodes.SERVER_ERROR, assistantUnavailableReason() ?? "Assistant unavailable"));
	}

	const parsed = streamSchema.safeParse(req.body);
	if (!parsed.success) {
		return res
			.status(400)
			.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "Invalid request", parsed.error.issues));
	}

	let ctx: AgentContext;
	try {
		ctx = await agentContextFrom(req);
	} catch (err) {
		return next(err);
	}

	const policy = activePolicy();
	const tools = describeTools({
		permissions: ctx.permissions,
		allowWrites: policy.allowWrites,
		allowDestructive: policy.allowDestructive,
	});
	if (!tools.length) {
		return res
			.status(403)
			.json(
				createErrorResponse(
					ErrorCodes.INVALID_CREDENTIALS,
					"Your permissions do not reach anything the assistant can look up.",
				),
			);
	}

	if (!acquireStream(ctx.userId)) {
		return res
			.status(429)
			.json(
				createErrorResponse(
					ErrorCodes.TOO_MANY_REQUESTS,
					"You already have the maximum number of assistant replies in flight. Wait for one to finish.",
				),
			);
	}

	let quota;
	try {
		quota = await consumeQuota(ctx.organizationId, "ai_calls_month");
	} catch (err) {
		releaseStream(ctx.userId);
		return next(err);
	}
	if (!quota.allowed) {
		releaseStream(ctx.userId);
		return res
			.status(429)
			.json(
				createErrorResponse(
					ErrorCodes.QUOTA_EXCEEDED,
					"Monthly AI assistant limit reached. It resets on the 1st (UTC).",
				),
			);
	}

	// Everything past this point owns the response: errors go into the stream,
	// not to the express error handler, which would try to send headers again.
	const sink = openEventStream(res);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
	req.on("close", () => controller.abort());

	try {
		let conversationId = parsed.data.conversation_id;
		let title: string | null = null;

		if (conversationId) {
			const existing = await getConversation(ctx, conversationId);
			title = existing.title;
		} else {
			const created = await createConversation(ctx, deriveTitle(parsed.data.message));
			conversationId = created.id;
			title = created.title;
		}

		sink.send({ type: "conversation", id: conversationId, title });

		const timezone = await orgTimezone(ctx.organizationId);

		await runTurn({
			ctx,
			policy,
			timezone,
			conversationId,
			userMessage: parsed.data.message,
			emit: (event) => sink.send(event),
			signal: controller.signal,
		});
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			sink.send({ type: "error", code: "NOT_FOUND", message: "That conversation no longer exists." });
		} else if (err instanceof AssistantNotConfiguredError) {
			sink.send({ type: "error", code: "NOT_CONFIGURED", message: "The assistant is not configured on this server." });
		} else if (controller.signal.aborted) {
			// Either the client navigated away or the turn ran past its budget.
			// Nothing useful to say to a socket that is probably already gone.
			log.info({ evt: "assistant.turn_aborted", org: ctx.organizationId }, "Assistant turn aborted");
		} else {
			log.error({ err, evt: "assistant.turn_failed", org: ctx.organizationId }, "Assistant turn failed");
			sink.send({
				type: "error",
				code: "SERVER_ERROR",
				message: "Something went wrong reaching the assistant. Try again.",
			});
		}
	} finally {
		clearTimeout(timeout);
		releaseStream(ctx.userId);
		sink.close();
	}
});

// ── Approvals ───────────────────────────────────────────────────────────────

const approvalSchema = z.object({ decision: z.enum(["approve", "reject"]) });

/**
 * GET /assistant/conversations/:id/approvals
 *
 * What is still waiting on this person. The panel calls it on open so a pending
 * action survives a page refresh — an approval that vanishes when a tab reloads
 * is one that gets forgotten, and forgotten work is the thing dispatch software
 * exists to prevent.
 */
router.get("/conversations/:id/approvals", async (req, res, next) => {
	try {
		const ctx = await agentContextFrom(req);
		const conversationId = req.params.id as string;
		await getConversation(ctx, conversationId);

		const pending = await listPendingApprovals(ctx, conversationId);
		res.json(
			createSuccessResponse(
				pending.map((call) => ({
					approvalId: call.id,
					id: call.provider_call_id,
					name: call.tool_name,
					title: getTool(call.tool_name)?.title ?? call.tool_name,
					summary: describeToolCall(call.tool_name, call.input),
					input: call.input,
				})),
				{ count: pending.length },
			),
		);
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "No such conversation"));
		}
		next(err);
	}
});

/**
 * POST /assistant/approvals/:id
 *
 * Decide one pending call, then resume the turn on the same response.
 *
 * The decision is recorded before anything runs, and the transcript is rebuilt
 * from the database rather than from memory — so a decision made after a refresh,
 * or from a second tab, resumes correctly. Once every pending call in the
 * conversation is decided, the model continues; until then the stream just
 * confirms this one and closes.
 */
router.post("/approvals/:id", async (req, res, next) => {
	if (!isAssistantEnabled()) {
		return res
			.status(503)
			.json(createErrorResponse(ErrorCodes.SERVER_ERROR, assistantUnavailableReason() ?? "Assistant unavailable"));
	}

	const parsed = approvalSchema.safeParse(req.body);
	if (!parsed.success) {
		return res
			.status(400)
			.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "decision must be \"approve\" or \"reject\""));
	}

	let ctx: AgentContext;
	try {
		ctx = await agentContextFrom(req);
	} catch (err) {
		return next(err);
	}

	const approvalId = req.params.id as string;

	// Resolve and validate before opening a stream, so a bad request still gets a
	// normal JSON error rather than an error event nobody is listening for.
	let pending: Awaited<ReturnType<typeof getPendingApproval>>;
	try {
		pending = await getPendingApproval(ctx, approvalId);
	} catch (err) {
		if (err instanceof ConversationAccessError) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "No such pending action"));
		}
		return next(err);
	}

	if (pending.status !== TOOL_CALL_STATUS.PENDING) {
		return res
			.status(409)
			.json(
				createErrorResponse(
					ErrorCodes.CONFLICT,
					`That action was already ${pending.status === TOOL_CALL_STATUS.EXPIRED ? "cancelled" : "decided"}.`,
				),
			);
	}

	if (!acquireStream(ctx.userId)) {
		return res
			.status(429)
			.json(
				createErrorResponse(
					ErrorCodes.TOO_MANY_REQUESTS,
					"You already have the maximum number of assistant replies in flight. Wait for one to finish.",
				),
			);
	}

	const sink = openEventStream(res);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
	req.on("close", () => controller.abort());

	try {
		const conversationId = pending.message.conversation.id;
		const approved = parsed.data.decision === "approve";

		// How often people decline is the clearest signal available on whether the
		// assistant is proposing the right things.
		assistantApprovals.add(1, {
			tool: pending.tool_name,
			decision: approved ? "approved" : "declined",
		});

		if (approved) {
			const tool = getTool(pending.tool_name);
			if (!tool) {
				// The catalog changed under a pending approval. Refusing is the only
				// safe reading — running a differently-named tool is not what anyone agreed to.
				await resolveToolCall(ctx, approvalId, {
					status: TOOL_CALL_STATUS.ERROR,
					result: { ok: false, error: { code: "UNKNOWN_TOOL", message: "That action no longer exists." } },
					errorCode: "UNKNOWN_TOOL",
				});
				sink.send({ type: "error", code: "UNKNOWN_TOOL", message: "That action no longer exists." });
			} else {
				const started = Date.now();
				const result = await executeTool(pending.tool_name, pending.input, ctx, activePolicy(), {
					approved: true,
				});
				const durationMs = Date.now() - started;

				await resolveToolCall(ctx, approvalId, {
					status: result.ok ? TOOL_CALL_STATUS.OK : TOOL_CALL_STATUS.ERROR,
					result,
					errorCode: result.ok ? null : result.error.code,
					durationMs,
				});

				sink.send({ type: "approval_resolved", approvalId, id: pending.provider_call_id, approved: true });
				if (result.ok) {
					sink.send({
						type: "tool_result",
						id: pending.provider_call_id,
						ok: true,
						summary: summariseToolResult(pending.tool_name, pending.input, result.data),
						durationMs,
					});
					if (result.meta?.invalidates?.length) {
						sink.send({ type: "invalidate", keys: result.meta.invalidates });
					}
				} else {
					sink.send({
						type: "tool_result",
						id: pending.provider_call_id,
						ok: false,
						summary: `${pending.tool_name} failed`,
						errorCode: result.error.code,
						errorMessage: result.error.message,
						durationMs,
					});
				}
			}
		} else {
			await resolveToolCall(ctx, approvalId, {
				status: TOOL_CALL_STATUS.REJECTED,
				result: { ok: false, error: { code: "REJECTED", message: "The person declined this action." } },
				errorCode: "REJECTED",
			});
			sink.send({ type: "approval_resolved", approvalId, id: pending.provider_call_id, approved: false });
			sink.send({
				type: "tool_result",
				id: pending.provider_call_id,
				ok: false,
				summary: "Declined",
				errorCode: "REJECTED",
				errorMessage: "You declined this action.",
				durationMs: 0,
			});
		}

		// Only continue once nothing else in this conversation is waiting — a turn
		// resumed with a call still undecided would ask the model to reason about
		// an action whose outcome nobody has chosen.
		const stillPending = await listPendingApprovals(ctx, conversationId);
		if (stillPending.length) {
			sink.send({ type: "done", messageId: null, usage: null });
		} else {
			const timezone = await orgTimezone(ctx.organizationId);
			await resumeTurn({
				ctx,
				policy: activePolicy(),
				timezone,
				conversationId,
				emit: (event) => sink.send(event),
				signal: controller.signal,
			});
		}
	} catch (err) {
		if (controller.signal.aborted) {
			log.info({ evt: "assistant.approval_aborted", org: ctx.organizationId }, "Approval resume aborted");
		} else {
			log.error({ err, evt: "assistant.approval_failed", org: ctx.organizationId }, "Approval failed");
			sink.send({ type: "error", code: "SERVER_ERROR", message: "Something went wrong applying that decision." });
		}
	} finally {
		clearTimeout(timeout);
		releaseStream(ctx.userId);
		sink.close();
	}
});

export default router;
