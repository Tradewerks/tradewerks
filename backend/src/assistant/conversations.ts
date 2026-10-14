/**
 * Conversation persistence and transcript replay.
 *
 * Every read and write here goes through `getScopedDb`, and the three assistant
 * models are registered in `lib/context.ts` (assistant_conversation directly,
 * messages and tool calls through their parents), so a conversation belonging to
 * another organization is unreachable rather than merely unlisted.
 *
 * Ownership within an org is a second, separate check: `assertOwned` refuses a
 * conversation belonging to a different user. Being in the same organization
 * does not make someone else's chat history yours.
 */

import type OpenAI from "openai";
import { getScopedDb } from "../lib/context.js";
import { HISTORY_WINDOW } from "./config.js";
import type { AgentContext } from "../agent/types.js";

export interface PersistedToolCall {
	provider_call_id: string;
	tool_name: string;
	input: unknown;
	status: string;
	result: unknown;
	error_code?: string | null;
	duration_ms?: number | null;
}

export async function createConversation(ctx: AgentContext, title?: string) {
	const db = getScopedDb(ctx.organizationId);
	return db.assistant_conversation.create({
		data: {
			organization_id: ctx.organizationId,
			user_id: ctx.userId,
			user_role: ctx.role,
			title: title ?? null,
		},
		select: { id: true, title: true, created_at: true, updated_at: true },
	});
}

export async function listConversations(ctx: AgentContext, limit = 30) {
	const db = getScopedDb(ctx.organizationId);
	return db.assistant_conversation.findMany({
		where: { user_id: ctx.userId, archived_at: null },
		select: { id: true, title: true, created_at: true, updated_at: true },
		orderBy: { updated_at: "desc" },
		take: limit,
	});
}

export class ConversationAccessError extends Error {
	constructor(message = "No such conversation") {
		super(message);
		this.name = "ConversationAccessError";
	}
}

/**
 * Fetch a conversation, refusing one that belongs to somebody else.
 *
 * The org filter is already applied by the scoped client; this adds the
 * per-user check on top. Both failures return the same error — confirming that
 * a conversation exists but belongs to a colleague is still a disclosure.
 */
async function assertOwned(ctx: AgentContext, conversationId: string) {
	const db = getScopedDb(ctx.organizationId);
	const conversation = await db.assistant_conversation.findFirst({
		where: { id: conversationId, user_id: ctx.userId },
		select: { id: true, title: true, created_at: true, updated_at: true },
	});
	if (!conversation) throw new ConversationAccessError();
	return conversation;
}

export async function getConversation(ctx: AgentContext, conversationId: string) {
	return assertOwned(ctx, conversationId);
}

export async function archiveConversation(ctx: AgentContext, conversationId: string) {
	await assertOwned(ctx, conversationId);
	const db = getScopedDb(ctx.organizationId);
	await db.assistant_conversation.update({
		where: { id: conversationId },
		data: { archived_at: new Date() },
	});
}

export async function renameConversation(ctx: AgentContext, conversationId: string, title: string) {
	await assertOwned(ctx, conversationId);
	const db = getScopedDb(ctx.organizationId);
	return db.assistant_conversation.update({
		where: { id: conversationId },
		data: { title },
		select: { id: true, title: true, updated_at: true },
	});
}

/** Messages for the UI, oldest first, with their tool calls attached. */
export async function loadMessages(ctx: AgentContext, conversationId: string, limit = HISTORY_WINDOW) {
	await assertOwned(ctx, conversationId);
	const db = getScopedDb(ctx.organizationId);

	// Newest-first with a take, then reversed: the tail is the part worth keeping
	// when a conversation outgrows the window.
	const rows = await db.assistant_message.findMany({
		where: { conversation_id: conversationId },
		select: {
			id: true,
			role: true,
			content: true,
			created_at: true,
			input_tokens: true,
			output_tokens: true,
			tool_calls: {
				select: {
					id: true,
					provider_call_id: true,
					tool_name: true,
					input: true,
					status: true,
					result: true,
					error_code: true,
					duration_ms: true,
				},
			},
		},
		orderBy: { created_at: "desc" },
		take: limit,
	});
	return rows.reverse();
}

export async function appendUserMessage(ctx: AgentContext, conversationId: string, content: string) {
	const db = getScopedDb(ctx.organizationId);
	const message = await db.assistant_message.create({
		data: { conversation_id: conversationId, role: "user", content },
		select: { id: true, created_at: true },
	});
	await db.assistant_conversation.update({
		where: { id: conversationId },
		data: { updated_at: new Date() },
	});
	return message;
}

export async function appendAssistantMessage(
	ctx: AgentContext,
	conversationId: string,
	message: {
		content: string;
		model: string;
		finishReason: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
		/**
		 * The slice of `inputTokens` that was served from the prompt cache, and the
		 * slice of `outputTokens` the model spent thinking. Both are needed to turn
		 * a token count into money: cached input bills at a tenth of the rate, and
		 * reasoning tokens bill at the full output rate while never reaching the
		 * user. Without them the per-org cost query overstates spend severalfold.
		 */
		cachedInputTokens: number | null;
		reasoningTokens: number | null;
		toolCalls: PersistedToolCall[];
	},
) {
	const db = getScopedDb(ctx.organizationId);
	const row = await db.assistant_message.create({
		data: {
			conversation_id: conversationId,
			role: "assistant",
			content: message.content,
			model: message.model,
			finish_reason: message.finishReason,
			input_tokens: message.inputTokens,
			output_tokens: message.outputTokens,
			cached_input_tokens: message.cachedInputTokens,
			reasoning_tokens: message.reasoningTokens,
			tool_calls: {
				create: message.toolCalls.map((call) => ({
					provider_call_id: call.provider_call_id,
					tool_name: call.tool_name,
					// Prisma's recursive InputJsonValue cannot be proven to accept `unknown`,
					// but every value here has already round-tripped through JSON.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					input: call.input as any,
					status: call.status,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					result: call.result as any,
					error_code: call.error_code ?? null,
					duration_ms: call.duration_ms ?? null,
					completed_at: new Date(),
				})),
			},
		},
		// Return the created tool calls so the caller does not have to re-read the
		// "newest message" to learn their ids — an assumption that would break the
		// moment two rows shared a created_at.
		select: {
			id: true,
			created_at: true,
			tool_calls: { select: { id: true, provider_call_id: true, tool_name: true, input: true, status: true } },
		},
	});
	await db.assistant_conversation.update({
		where: { id: conversationId },
		data: { updated_at: new Date() },
	});
	return row;
}

type StoredMessage = Awaited<ReturnType<typeof loadMessages>>[number];
type StoredToolCall = StoredMessage["tool_calls"][number];

/** Lifecycle of a call that needs a human decision. */
export const TOOL_CALL_STATUS = {
	OK: "ok",
	ERROR: "error",
	PENDING: "pending_approval",
	REJECTED: "rejected",
	/** The person moved on and asked something else before deciding. */
	EXPIRED: "expired",
} as const;

/**
 * What the model is told a call returned.
 *
 * A call awaiting a decision has no result yet, but the transcript still needs
 * a `tool` message for it — the API rejects a `tool_calls` entry with no
 * matching response. Undecided, refused and expired calls each get a distinct
 * explanation so the model does not read silence as success and report an
 * action it never took.
 */
function resultForTranscript(call: StoredToolCall): unknown {
	switch (call.status) {
		case TOOL_CALL_STATUS.PENDING:
			return {
				ok: false,
				error: {
					code: "APPROVAL_PENDING",
					message: "Waiting for the person to approve this. It has NOT run. Do not report it as done.",
				},
			};
		case TOOL_CALL_STATUS.REJECTED:
			return {
				ok: false,
				error: {
					code: "REJECTED",
					message: "The person declined this action. It did not run. Acknowledge that and stop; do not retry it.",
				},
			};
		case TOOL_CALL_STATUS.EXPIRED:
			return {
				ok: false,
				error: {
					code: "EXPIRED",
					message: "This was never approved and has been cancelled because the conversation moved on.",
				},
			};
		default:
			return call.result ?? { ok: false, error: "no result recorded" };
	}
}



/**
 * Rebuild the model transcript from stored rows.
 *
 * The Responses API takes a flat list of items rather than messages with nested
 * tool calls: an assistant turn that called tools replays as its text (if it had
 * any), then one `function_call` item per call, then one `function_call_output`
 * per result. Each output pairs back to its call via `call_id`, which is what
 * `provider_call_id` holds — a `function_call_output` whose `call_id` matches no
 * preceding `function_call` is a hard error, and that is why the provider's id
 * is stored rather than regenerated on replay.
 *
 * Reasoning items are deliberately absent. They live only inside a single turn,
 * carried in memory by the loop; nothing encrypted is persisted here.
 */
export function toTranscript(messages: StoredMessage[]): OpenAI.Responses.ResponseInputItem[] {
	const out: OpenAI.Responses.ResponseInputItem[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: message.content });
			continue;
		}

		const calls = message.tool_calls ?? [];

		// An assistant turn with neither text nor tool calls carries nothing the
		// model needs; replaying it just wastes context.
		if (message.content.trim()) out.push({ role: "assistant", content: message.content });
		if (!calls.length) continue;

		for (const call of calls) {
			out.push({
				type: "function_call",
				call_id: call.provider_call_id,
				name: call.tool_name,
				arguments: JSON.stringify(call.input ?? {}),
			});
		}

		for (const call of calls) {
			out.push({
				type: "function_call_output",
				call_id: call.provider_call_id,
				output: JSON.stringify(resultForTranscript(call)),
			});
		}
	}

	return out;
}

/**
 * A title derived from the opening question, used until something better exists.
 * Cheap on purpose — spending a model call to name a chat is not worth it.
 */
export function deriveTitle(firstMessage: string): string {
	const flat = firstMessage.replace(/\s+/g, " ").trim();
	if (flat.length <= 60) return flat || "New conversation";
	return `${flat.slice(0, 57)}…`;
}

// ── Approvals ───────────────────────────────────────────────────────────────

/**
 * A pending call, with enough of its conversation to check ownership.
 *
 * Read through the scoped client (assistant_tool_call is relation-scoped two
 * levels deep in lib/context.ts), then checked against the caller's user id —
 * being in the same organization does not make a colleague's pending action
 * yours to approve.
 */
export async function getPendingApproval(ctx: AgentContext, toolCallId: string) {
	const db = getScopedDb(ctx.organizationId);
	const call = await db.assistant_tool_call.findFirst({
		where: { id: toolCallId },
		select: {
			id: true,
			provider_call_id: true,
			tool_name: true,
			input: true,
			status: true,
			message: {
				select: {
					id: true,
					conversation: { select: { id: true, user_id: true } },
				},
			},
		},
	});

	if (!call || call.message.conversation.user_id !== ctx.userId) {
		throw new ConversationAccessError("No such pending action");
	}
	return call;
}

/** Write a decision onto a pending call. */
export async function resolveToolCall(
	ctx: AgentContext,
	toolCallId: string,
	outcome: { status: string; result: unknown; errorCode?: string | null; durationMs?: number | null },
) {
	const db = getScopedDb(ctx.organizationId);
	await db.assistant_tool_call.update({
		where: { id: toolCallId },
		data: {
			status: outcome.status,
			// Prisma's recursive InputJsonValue cannot be proven to accept `unknown`;
			// every value here has already round-tripped through JSON.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			result: outcome.result as any,
			error_code: outcome.errorCode ?? null,
			duration_ms: outcome.durationMs ?? null,
			approved_by: ctx.userId,
			completed_at: new Date(),
		},
	});
}

/** Calls in this conversation still waiting on a decision, oldest first. */
export async function listPendingApprovals(ctx: AgentContext, conversationId: string) {
	const db = getScopedDb(ctx.organizationId);
	return db.assistant_tool_call.findMany({
		where: {
			status: TOOL_CALL_STATUS.PENDING,
			message: { conversation_id: conversationId },
		},
		select: { id: true, provider_call_id: true, tool_name: true, input: true, created_at: true },
		orderBy: { created_at: "asc" },
	});
}

/**
 * Cancel anything still undecided in this conversation.
 *
 * Called when the person sends a new message instead of deciding. An approval
 * left hanging while the conversation moved on is a trap: agreeing to it ten
 * minutes later would fire an action nobody is thinking about any more. Letting
 * it lapse is the safer default, and the model is told it lapsed.
 */
export async function expirePendingApprovals(ctx: AgentContext, conversationId: string): Promise<number> {
	const db = getScopedDb(ctx.organizationId);
	const { count } = await db.assistant_tool_call.updateMany({
		where: {
			status: TOOL_CALL_STATUS.PENDING,
			message: { conversation_id: conversationId },
		},
		data: { status: TOOL_CALL_STATUS.EXPIRED, completed_at: new Date() },
	});
	return count;
}
