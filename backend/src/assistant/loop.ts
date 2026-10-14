/**
 * The agent loop: user message → model → tools → model → answer.
 *
 * The loop owns no business logic. It streams a completion, hands any tool calls
 * to `executeTool` (which applies policy, permissions, tenancy and audit), feeds
 * the results back, and repeats until the model stops asking for tools. Every
 * security decision was made in Phase 1; this file must not add an exception to
 * one.
 *
 * Each model turn is persisted separately rather than collapsed into a single
 * assistant message. A turn that calls tools, answers, then calls more tools has
 * an order that matters — `toTranscript` has to replay it exactly or the API
 * rejects the request.
 *
 * The transport is the Responses API. Chat Completions cannot carry function
 * tools and a reasoning effort above `none` on the GPT-5.6 family, and it throws
 * away the model's reasoning between the tool call and the answer that follows
 * it — which is the whole middle of this loop. Responses returns reasoning items
 * that get handed straight back on the next request, so a turn that searches,
 * reads and then answers thinks once rather than three times from scratch.
 */

import type OpenAI from "openai";
import { executeTool, toolRequiresApproval } from "../agent/execute.js";
import { getTool } from "../agent/registry.js";
import type { AgentContext, AgentPolicy } from "../agent/types.js";
import { log } from "../services/appLogger.js";
import { assistantTokens, assistantTurns } from "../services/metricsService.js";
import { ASSISTANT_MODEL, MAX_OUTPUT_TOKENS, MAX_TOOL_ITERATIONS, REASONING_EFFORT } from "./config.js";
import {
	appendAssistantMessage,
	appendUserMessage,
	expirePendingApprovals,
	loadMessages,
	toTranscript,
	TOOL_CALL_STATUS,
	type PersistedToolCall,
} from "./conversations.js";
import type { AssistantEvent } from "./events.js";
import { getOpenAI } from "./openaiClient.js";
import { buildInstructions, buildTurnContext } from "./prompt.js";
import { describeToolCall, parseToolArguments, summariseToolResult, toolsForOpenAI } from "./toolBridge.js";

export interface TurnOptions {
	ctx: AgentContext;
	policy: AgentPolicy;
	timezone: string;
	conversationId: string;
	userMessage: string;
	emit: (event: AssistantEvent) => void;
	signal: AbortSignal;
	/** Injected for testability; defaults to the wall clock. */
	now?: Date;
}

/** A tool call the model asked for, in the shape the rest of the loop wants. */
interface PendingCall {
	id: string;
	name: string;
	args: string;
}

/**
 * What one model turn cost, split finely enough to price.
 *
 * `cachedInput` is the part of `input` served from the prompt cache, which bills
 * at roughly a tenth of the rate; `reasoning` is the part of `output` the model
 * spent thinking, which bills at the full output rate and never reaches the
 * user. A turn's real cost is unknowable from the two totals alone.
 */
interface TurnUsage {
	input: number;
	output: number;
	cachedInput: number;
	reasoning: number;
}

interface StreamedTurn {
	text: string;
	calls: PendingCall[];
	/**
	 * The model's own output items, verbatim, to hand back on the next request.
	 *
	 * Carrying the reasoning items is the point: without them the model re-derives
	 * its plan from scratch after every tool result. They are filtered to the three
	 * kinds this loop can produce rather than passed through blindly, because the
	 * output union is wider than the input union and the difference is a type
	 * error at best and a rejected request at worst.
	 */
	outputItems: OpenAI.Responses.ResponseInputItem[];
	finishReason: string | null;
	/** The response ran into `max_output_tokens` before it finished. */
	truncated: boolean;
	usage: TurnUsage | null;
}

/**
 * Consume one streamed response.
 *
 * Text arrives as deltas and is forwarded to the browser as it lands. Everything
 * structural — tool calls, reasoning, usage — is read off the completed response
 * at the end rather than reassembled from fragments: the Responses API hands
 * back whole items, so the accumulate-by-index dance Chat Completions required
 * is gone.
 */
async function streamOnce(
	client: OpenAI,
	instructions: string,
	input: OpenAI.Responses.ResponseInputItem[],
	tools: OpenAI.Responses.FunctionTool[],
	emit: (event: AssistantEvent) => void,
	signal: AbortSignal,
): Promise<StreamedTurn> {
	const stream = await client.responses.create(
		{
			model: ASSISTANT_MODEL,
			instructions,
			input,
			// An empty tools array is a request error, and a caller whose permissions
			// reach nothing legitimately has one.
			...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
			reasoning: {
				effort: REASONING_EFFORT,
				// The gpt-5.6 family would otherwise default to `all_turns`, expecting
				// reasoning items from earlier turns that this loop cannot supply: the
				// transcript is rebuilt from the database, and nothing encrypted is
				// persisted there. Ask for what can actually be provided.
				context: "current_turn",
			},
			// Reasoning is returned encrypted so it can be replayed on the next
			// request without OpenAI storing it. Required because `store` is false.
			include: ["reasoning.encrypted_content"],
			// Nothing is retained on OpenAI's side. This is a multi-tenant product
			// holding other companies' client records, and the API defaults to
			// storing responses for 30 days — a data-residency decision nobody here
			// made deliberately. The transcript already lives in our own database.
			store: false,
			stream: true,
			// Counts reasoning tokens as well as visible ones; see MAX_OUTPUT_TOKENS.
			max_output_tokens: MAX_OUTPUT_TOKENS,
			// Temperature is deliberately unset: reasoning models reject it, and the
			// default is right for this workload anyway.
		},
		{ signal },
	);

	let text = "";
	let finishReason: string | null = null;
	let truncated = false;
	let usage: TurnUsage | null = null;
	const calls: PendingCall[] = [];
	const outputItems: OpenAI.Responses.ResponseInputItem[] = [];

	for await (const event of stream) {
		if (event.type === "response.output_text.delta") {
			text += event.delta;
			emit({ type: "text_delta", text: event.delta });
			continue;
		}

		// `failed` carries a provider-side error that never becomes a response;
		// throwing puts it on the same path as a transport failure, which the
		// caller already turns into an `error` event in the thread.
		if (event.type === "response.failed") {
			throw new Error(event.response.error?.message ?? "The model failed to produce a response");
		}

		if (event.type !== "response.completed" && event.type !== "response.incomplete") continue;

		const response = event.response;
		finishReason = response.incomplete_details?.reason ?? response.status ?? null;
		truncated = response.incomplete_details?.reason === "max_output_tokens";

		if (response.usage) {
			usage = {
				input: response.usage.input_tokens ?? 0,
				output: response.usage.output_tokens ?? 0,
				cachedInput: response.usage.input_tokens_details?.cached_tokens ?? 0,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
			};
		}

		for (const item of response.output ?? []) {
			if (item.type === "function_call") {
				calls.push({ id: item.call_id, name: item.name, args: item.arguments });
				outputItems.push(item);
			} else if (item.type === "reasoning" || item.type === "message") {
				outputItems.push(item);
			}
		}
	}

	return { text, calls, outputItems, finishReason, truncated, usage };
}

/** One turn's usage in the shape `appendAssistantMessage` stores it. */
const usageOf = (turn: StreamedTurn) => ({
	inputTokens: turn.usage?.input ?? null,
	outputTokens: turn.usage?.output ?? null,
	cachedInputTokens: turn.usage?.cachedInput ?? null,
	reasoningTokens: turn.usage?.reasoning ?? null,
});

/**
 * Drive the model→tool→model loop over an already-built transcript.
 *
 * Shared by a fresh turn and by one resumed after an approval, so the two cannot
 * drift on how tools are run, how failures are reported, or when the loop stops.
 *
 * Returns `paused` when a call needs a human decision: the turn stops there, the
 * pending call is persisted, and deciding it starts a new stream that calls back
 * into here. Blocking the open SSE connection instead would tie the action to a
 * socket that a page refresh destroys.
 */
async function driveLoop(
	options: TurnOptions,
	instructions: string,
	// Named `items`, not `input`: the per-call tool arguments a few lines down are
	// also called `input`, and one of the two shadowing the other is a bug waiting
	// for someone to move a push into the wrong block.
	items: OpenAI.Responses.ResponseInputItem[],
	seed: TurnUsage = { input: 0, output: 0, cachedInput: 0, reasoning: 0 },
): Promise<"done" | "paused" | "aborted"> {
	const { ctx, policy, conversationId, emit, signal } = options;
	const client = getOpenAI();
	const tools = toolsForOpenAI(ctx, policy);

	let lastMessageId: string | null = null;
	const total: TurnUsage = { ...seed };

	for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
		if (signal.aborted) return "aborted";

		const turn = await streamOnce(client, instructions, items, tools, emit, signal);
		total.input += turn.usage?.input ?? 0;
		total.output += turn.usage?.output ?? 0;
		total.cachedInput += turn.usage?.cachedInput ?? 0;
		total.reasoning += turn.usage?.reasoning ?? 0;

		// A response that hit the token ceiling is not an answer, and its last tool
		// call may have been cut off mid-arguments. Stop rather than run a call
		// assembled from a truncated stream, and say what happened: the old code
		// stored the finish reason and rendered the empty string, which reaches a
		// dispatcher as a blank reply with no indication anything went wrong.
		if (turn.truncated) {
			const saved = await appendAssistantMessage(ctx, conversationId, {
				content: turn.text,
				model: ASSISTANT_MODEL,
				finishReason: turn.finishReason,
				...usageOf(turn),
				toolCalls: [],
			});
			log.warn(
				{
					evt: "assistant.truncated",
					conversation: conversationId,
					org: ctx.organizationId,
					limit: MAX_OUTPUT_TOKENS,
					reasoning: turn.usage?.reasoning ?? 0,
				},
				"Assistant response hit max_output_tokens",
			);
			emit({
				type: "error",
				code: "OUTPUT_LIMIT",
				message: "I ran out of room before finishing that answer. Try asking for a smaller piece of it.",
			});
			recordTurn(ctx.surface, "output_limit", total);
			emit({ type: "done", messageId: saved.id, usage: { input: total.input, output: total.output } });
			return "done";
		}

		if (!turn.calls.length) {
			const saved = await appendAssistantMessage(ctx, conversationId, {
				content: turn.text,
				model: ASSISTANT_MODEL,
				finishReason: turn.finishReason,
				...usageOf(turn),
				toolCalls: [],
			});
			recordTurn(ctx.surface, "answered", total);
			emit({ type: "done", messageId: saved.id, usage: { input: total.input, output: total.output } });
			return "done";
		}

		const persisted: PersistedToolCall[] = [];
		let paused = false;

		for (const call of turn.calls) {
			if (signal.aborted) return "aborted";

			const parsed = parseToolArguments(call.args);
			const input = parsed.ok ? parsed.value : {};
			const definition = getTool(call.name);

			// A call that needs a decision is recorded, announced, and not run.
			// Everything already executed in this batch stands — those calls were
			// permitted to run unattended, and undoing them is not this loop's job.
			if (parsed.ok && definition && toolRequiresApproval(definition)) {
				paused = true;
				persisted.push({
					provider_call_id: call.id,
					tool_name: call.name,
					input,
					status: TOOL_CALL_STATUS.PENDING,
					result: null,
					duration_ms: null,
				});
				continue;
			}

			emit({ type: "tool_call", id: call.id, name: call.name, input });

			const started = Date.now();
			// A malformed arguments string is reported back as a tool failure rather
			// than executed with a guess — the model can then correct itself, which
			// it cannot do if the turn simply ends.
			const result = parsed.ok
				? await executeTool(call.name, input, ctx, policy)
				: ({ ok: false, error: { code: "VALIDATION_ERROR" as const, message: parsed.message } } as const);
			const durationMs = Date.now() - started;

			emitToolResult(emit, call.id, call.name, input, result, durationMs);

			persisted.push({
				provider_call_id: call.id,
				tool_name: call.name,
				input,
				status: result.ok ? TOOL_CALL_STATUS.OK : TOOL_CALL_STATUS.ERROR,
				result,
				error_code: result.ok ? null : result.error.code,
				duration_ms: durationMs,
			});
		}

		const saved = await appendAssistantMessage(ctx, conversationId, {
			content: turn.text,
			model: ASSISTANT_MODEL,
			finishReason: turn.finishReason,
			...usageOf(turn),
			toolCalls: persisted,
		});
		lastMessageId = saved.id;

		if (paused) {
			// Announce every pending call with its stored id, which is what the
			// approval endpoint takes — the ids come back from the write itself
			// rather than from a follow-up read of "the newest message".
			for (const call of saved.tool_calls) {
				if (call.status !== TOOL_CALL_STATUS.PENDING) continue;
				const definition = getTool(call.tool_name);
				emit({
					type: "approval_required",
					approvalId: call.id,
					id: call.provider_call_id,
					name: call.tool_name,
					title: definition?.title ?? call.tool_name,
					summary: describeToolCall(call.tool_name, call.input),
					input: call.input,
				});
			}
			recordTurn(ctx.surface, "awaiting_approval", total);
			emit({ type: "done", messageId: lastMessageId, usage: { input: total.input, output: total.output } });
			return "paused";
		}

		// The model's own items go back verbatim and in their original order — the
		// reasoning that led to a call has to sit ahead of the call it produced.
		// Then one output per call, paired by `call_id`; a call left without one is
		// rejected outright on the next request.
		items.push(...turn.outputItems);
		for (const call of persisted) {
			items.push({
				type: "function_call_output",
				call_id: call.provider_call_id,
				output: JSON.stringify(call.result),
			});
		}
	}

	// Ran out of iterations with the model still asking for tools. Say so rather
	// than presenting a partial answer as a complete one.
	log.warn(
		{ evt: "assistant.iteration_limit", conversation: conversationId, org: ctx.organizationId },
		"Assistant turn hit the tool iteration limit",
	);
	emit({
		type: "error",
		code: "ITERATION_LIMIT",
		message: `I looked things up ${MAX_TOOL_ITERATIONS} times without reaching an answer. Try narrowing the question.`,
	});
	recordTurn(ctx.surface, "iteration_limit", total);
	emit({ type: "done", messageId: lastMessageId, usage: { input: total.input, output: total.output } });
	return "done";
}

/**
 * One place that records how a turn ended and what it cost.
 *
 * Token counts are also stored per message (see appendAssistantMessage) — the
 * metric answers "what is this costing us right now", the table answers "what
 * did this organization cost last month". Neither substitutes for the other.
 */
function recordTurn(surface: string, outcome: string, usage: TurnUsage): void {
	assistantTurns.add(1, { surface, outcome });
	const model = ASSISTANT_MODEL;
	// Uncached input is separated from cached rather than reported as one number:
	// they differ by roughly 10x in price, so the totals alone cannot be costed,
	// and the ratio between them is the health check on prompt caching.
	const uncachedInput = Math.max(0, usage.input - usage.cachedInput);
	if (uncachedInput) assistantTokens.add(uncachedInput, { direction: "input", model });
	if (usage.cachedInput) assistantTokens.add(usage.cachedInput, { direction: "cached_input", model });
	if (usage.output) assistantTokens.add(usage.output, { direction: "output", model });
	if (usage.reasoning) assistantTokens.add(usage.reasoning, { direction: "reasoning", model });
}

/** `get_technician_availability` → "Get technician availability" */
const humanise = (name: string): string => {
	const words = name.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Emit the result of one executed call, plus any cache keys it invalidated. */
function emitToolResult(
	emit: (event: AssistantEvent) => void,
	id: string,
	name: string,
	input: unknown,
	result: Awaited<ReturnType<typeof executeTool>>,
	durationMs: number,
): void {
	if (result.ok) {
		emit({
			type: "tool_result",
			id,
			ok: true,
			summary: summariseToolResult(name, input, result.data),
			durationMs,
		});
		if (result.meta?.invalidates?.length) {
			emit({ type: "invalidate", keys: result.meta.invalidates });
		}
	} else {
		emit({
			type: "tool_result",
			id,
			ok: false,
			// The reason, not just the fact. "propose_draft failed" tells a
			// dispatcher nothing they can act on or report.
			summary: `${humanise(name)} failed — ${result.error.message}`,
			errorCode: result.error.code,
			errorMessage: result.error.message,
			durationMs,
		});
	}
}

/**
 * Run one user turn, emitting events as it goes.
 *
 * Returns rather than throws on failure: the caller has an open SSE stream, and
 * the useful thing to do with an error is put it in the thread.
 */
export async function runTurn(options: TurnOptions): Promise<void> {
	const { ctx, timezone, conversationId, userMessage } = options;
	const now = options.now ?? new Date();

	// Asking something new supersedes anything still awaiting a decision. Saying
	// yes ten minutes later would fire an action nobody is thinking about.
	const expired = await expirePendingApprovals(ctx, conversationId);
	if (expired) {
		log.info(
			{ evt: "assistant.approvals_expired", conversation: conversationId, count: expired },
			"Pending approvals lapsed because the conversation moved on",
		);
	}

	await appendUserMessage(ctx, conversationId, userMessage);

	const history = await loadMessages(ctx, conversationId);
	await driveLoop(options, buildInstructions(options.policy), [
		// Who and when go in the input, not in the instructions: everything ahead
		// of this point is byte-identical across users and days, which is what makes
		// the ~6k-token prefix cacheable. See prompt.ts.
		{ role: "developer", content: buildTurnContext({ ctx, timezone, now }) },
		...toTranscript(history),
	]);
}

/**
 * Continue a turn that paused for approval, once every pending call is decided.
 *
 * The transcript is rebuilt from the database rather than carried in memory, so
 * a decision made after a page refresh — or from another tab — resumes correctly.
 */
export async function resumeTurn(options: Omit<TurnOptions, "userMessage">): Promise<void> {
	const { ctx, timezone, conversationId } = options;
	const now = options.now ?? new Date();

	const history = await loadMessages(ctx, conversationId);
	await driveLoop({ ...options, userMessage: "" }, buildInstructions(options.policy), [
		{ role: "developer", content: buildTurnContext({ ctx, timezone, now }) },
		...toTranscript(history),
	]);
}
