import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	create,
	executeTool,
	appendUserMessage,
	appendAssistantMessage,
	loadMessages,
	expirePendingApprovals,
} = vi.hoisted(() => ({
	create: vi.fn(),
	executeTool: vi.fn(),
	appendUserMessage: vi.fn(async () => ({ id: "um-1", created_at: new Date() })),
	appendAssistantMessage: vi.fn(async () => ({ id: "am-1", created_at: new Date(), tool_calls: [] as unknown[] })),
	loadMessages: vi.fn(async (_ctx: unknown, _id: string, _limit?: number) => [] as unknown[]),
	expirePendingApprovals: vi.fn(async () => 0),
}));

vi.mock("../openaiClient.js", () => ({
	getOpenAI: () => ({ responses: { create } }),
	AssistantNotConfiguredError: class extends Error {},
}));
vi.mock("../conversations.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../conversations.js")>()),
	appendUserMessage,
	appendAssistantMessage,
	loadMessages,
	expirePendingApprovals,
}));
vi.mock("../../agent/execute.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/execute.js")>()),
	executeTool,
}));
vi.mock("../../agent/registry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/registry.js")>()),
	// The loop asks the registry whether a tool needs approval. Tests register
	// their own stand-ins rather than importing the real catalog.
	getTool: (name: string) => registeredTools.get(name),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../toolBridge.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../toolBridge.js")>()),
	// The real one reads the tool registry; the loop only cares that it is non-empty.
	toolsForOpenAI: () => [{ type: "function", name: "get_record", parameters: {}, strict: false }],
}));

import { WRITE_POLICY } from "../../agent/policy.js";
import type { AgentContext } from "../../agent/types.js";
import type { AssistantEvent } from "../events.js";
import { runTurn } from "../loop.js";

/** Minimal tool definitions the loop can look up, keyed by name. */
const registeredTools = new Map<string, { name: string; title: string; risk: string; requiresApproval?: boolean }>([
	["get_record", { name: "get_record", title: "Get record", risk: "read" }],
	["get_schedule", { name: "get_schedule", title: "Get schedule", risk: "read" }],
	["search_records", { name: "search_records", title: "Search", risk: "read" }],
	[
		"reschedule_visit",
		{ name: "reschedule_visit", title: "Reschedule a visit", risk: "write", requiresApproval: true },
	],
	["add_job_note", { name: "add_job_note", title: "Add a note", risk: "write", requiresApproval: false }],
]);

const ctx: AgentContext = {
	userId: "u1",
	role: "dispatcher",
	organizationId: "org-1",
	permissions: ["view_jobs"],
	actorType: "dispatcher",
	surface: "assistant",
	userName: "Dana Reyes",
};

/** Build an async-iterable stream of Responses API events. */
const streamOf = (events: unknown[]) => ({
	async *[Symbol.asyncIterator]() {
		for (const event of events) yield event;
	},
});

const textDelta = (text: string) => ({ type: "response.output_text.delta", delta: text });

// ── Output items, as they come back on the completed response ──────────────
const messageItem = (text: string) => ({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text }],
});
const callItem = (callId: string, name: string, args: string) => ({
	type: "function_call",
	call_id: callId,
	name,
	arguments: args,
});
const reasoningItem = (id: string) => ({ type: "reasoning", id, summary: [], encrypted_content: `enc-${id}` });

const usage = (input: number, output: number, cached = 0, reasoning = 0) => ({
	input_tokens: input,
	output_tokens: output,
	input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
	output_tokens_details: { reasoning_tokens: reasoning },
});

const completed = (output: unknown[], u?: ReturnType<typeof usage>) => ({
	type: "response.completed",
	response: { status: "completed", incomplete_details: null, output, usage: u },
});

const incomplete = (output: unknown[], reason = "max_output_tokens", u?: ReturnType<typeof usage>) => ({
	type: "response.incomplete",
	response: { status: "incomplete", incomplete_details: { reason }, output, usage: u },
});

/** A turn that just answers, streaming its text first. */
const answers = (text: string, u?: ReturnType<typeof usage>) =>
	streamOf([textDelta(text), completed([messageItem(text)], u)]);

/** A turn that asks for one tool call. */
const asksFor = (callId: string, name: string, args: string, u?: ReturnType<typeof usage>) =>
	streamOf([completed([callItem(callId, name, args)], u)]);

async function run(overrides: Partial<Parameters<typeof runTurn>[0]> = {}) {
	const events: AssistantEvent[] = [];
	await runTurn({
		ctx,
		policy: WRITE_POLICY,
		timezone: "America/Chicago",
		conversationId: "conv-1",
		userMessage: "what is on for tuesday?",
		emit: (e) => events.push(e),
		signal: new AbortController().signal,
		now: new Date("2026-08-19T12:00:00Z"),
		...overrides,
	});
	return events;
}

const typesOf = (events: AssistantEvent[]) => events.map((e) => e.type);

describe("runTurn", () => {
	beforeEach(() => {
		create.mockReset();
		executeTool.mockReset();
		appendAssistantMessage.mockClear();
		appendAssistantMessage.mockResolvedValue({ id: "am-1", created_at: new Date(), tool_calls: [] });
		appendUserMessage.mockClear();
		loadMessages.mockClear();
		loadMessages.mockResolvedValue([]);
		expirePendingApprovals.mockClear();
		expirePendingApprovals.mockResolvedValue(0);
	});

	it("streams a plain answer and finishes", async () => {
		create.mockResolvedValueOnce(
			streamOf([textDelta("Two "), textDelta("visits."), completed([messageItem("Two visits.")], usage(120, 8))]),
		);

		const events = await run();

		expect(typesOf(events)).toEqual(["text_delta", "text_delta", "done"]);
		expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe(
			"Two visits.",
		);
		expect(events.at(-1)).toMatchObject({ type: "done", usage: { input: 120, output: 8 } });
	});

	it("persists the user turn before calling the model", async () => {
		create.mockResolvedValueOnce(answers("ok"));
		await run();
		expect(appendUserMessage).toHaveBeenCalledWith(ctx, "conv-1", "what is on for tuesday?");
	});

	it("records token counts on the assistant message", async () => {
		// The pricing question has to be answerable later, which means recording
		// usage from the first release rather than retrofitting it.
		create.mockResolvedValueOnce(answers("ok", usage(500, 40)));
		await run();
		expect(appendAssistantMessage.mock.calls[0][2]).toMatchObject({ inputTokens: 500, outputTokens: 40 });
	});

	it("records the cached and reasoning slices, not just the totals", async () => {
		// Neither total can be priced on its own: cached input bills at roughly a
		// tenth of the rate, and reasoning tokens bill at the full output rate
		// while never reaching the user.
		create.mockResolvedValueOnce(answers("ok", usage(6200, 900, 6000, 700)));
		await run();
		expect(appendAssistantMessage.mock.calls[0][2]).toMatchObject({
			inputTokens: 6200,
			outputTokens: 900,
			cachedInputTokens: 6000,
			reasoningTokens: 700,
		});
	});

	describe("the request", () => {
		it("sends the static instructions and puts who-and-when in the input", async () => {
			// The split is what makes the ~6k-token prefix cacheable: anything that
			// varies per person or per day has to sit after it, not inside it.
			create.mockResolvedValueOnce(answers("ok"));

			await run();

			const request = create.mock.calls[0][0];
			expect(request.instructions).toContain("dispatch assistant");
			expect(request.instructions).not.toContain("Dana Reyes");
			expect(request.instructions).not.toContain("2026-08-19");
			expect(request.input[0]).toMatchObject({ role: "developer" });
			expect(request.input[0].content).toContain("Dana Reyes");
			expect(request.input[0].content).toContain("2026-08-19");
		});

		it("replays the stored history after the turn context", async () => {
			loadMessages.mockResolvedValue([
				{ role: "user", content: "earlier question", tool_calls: [] },
				{ role: "assistant", content: "earlier answer", tool_calls: [] },
			] as never);
			create.mockResolvedValueOnce(answers("ok"));

			await run();

			expect(create.mock.calls[0][0].input.slice(1)).toEqual([
				{ role: "user", content: "earlier question" },
				{ role: "assistant", content: "earlier answer" },
			]);
		});

		it("keeps nothing on OpenAI's side and asks for reasoning it can replay", async () => {
			// This is a multi-tenant product holding other companies' client
			// records; the API would otherwise retain each response for 30 days.
			create.mockResolvedValueOnce(answers("ok"));

			await run();

			const request = create.mock.calls[0][0];
			expect(request.store).toBe(false);
			expect(request.include).toContain("reasoning.encrypted_content");
			expect(request.reasoning).toMatchObject({ context: "current_turn" });
			expect(request.max_output_tokens).toBeGreaterThan(2000);
		});
	});

	describe("tool calls", () => {
		it("runs the tool the model asked for and loops back", async () => {
			create
				.mockResolvedValueOnce(asksFor("call_1", "get_schedule", '{"start_date":"2026-08-25"}'))
				.mockResolvedValueOnce(answers("Three visits."));
			executeTool.mockResolvedValue({ ok: true, data: { total_visits: 3, unassigned: [] } });

			const events = await run();

			expect(executeTool).toHaveBeenCalledOnce();
			expect(executeTool.mock.calls[0][0]).toBe("get_schedule");
			expect(executeTool.mock.calls[0][1]).toEqual({ start_date: "2026-08-25" });
			expect(typesOf(events)).toEqual(["tool_call", "tool_result", "text_delta", "done"]);
			expect(events[1]).toMatchObject({ ok: true, summary: expect.stringContaining("3 visits") });
		});

		it("hands the model's reasoning back on the next request", async () => {
			// The point of the Responses API here: without this the model re-derives
			// its plan from scratch after every tool result.
			create
				.mockResolvedValueOnce(
					streamOf([completed([reasoningItem("rs_1"), callItem("c1", "get_record", "{}")])]),
				)
				.mockResolvedValueOnce(answers("done"));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			await run();

			const second = create.mock.calls[1][0].input;
			expect(second).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "enc-rs_1" }));
			// Reasoning has to precede the call it produced.
			const reasoningAt = second.findIndex((i: { type?: string }) => i.type === "reasoning");
			const callAt = second.findIndex((i: { type?: string }) => i.type === "function_call");
			expect(reasoningAt).toBeLessThan(callAt);
		});

		it("pairs each result back to its call in the follow-up request", async () => {
			create
				.mockResolvedValueOnce(asksFor("call_abc", "get_record", "{}"))
				.mockResolvedValueOnce(answers("ok"));
			executeTool.mockResolvedValue({ ok: true, data: { name: "Acme" } });

			await run();

			expect(create.mock.calls[1][0].input).toContainEqual(
				expect.objectContaining({ type: "function_call_output", call_id: "call_abc" }),
			);
		});

		it("passes the caller's context and policy to every tool call", async () => {
			// The loop must never widen what Phase 1 decided; it only forwards.
			create.mockResolvedValueOnce(asksFor("c1", "get_record", "{}")).mockResolvedValueOnce(answers("done"));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			await run();

			expect(executeTool.mock.calls[0][2]).toBe(ctx);
			expect(executeTool.mock.calls[0][3]).toBe(WRITE_POLICY);
		});

		it("runs several calls from one turn in order", async () => {
			create
				.mockResolvedValueOnce(
					streamOf([
						completed([
							callItem("c1", "search_records", '{"query":"acme"}'),
							callItem("c2", "get_record", '{"type":"client"}'),
						]),
					]),
				)
				.mockResolvedValueOnce(answers("ok"));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			await run();

			expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["search_records", "get_record"]);
		});

		it("feeds a tool failure back to the model instead of ending the turn", async () => {
			create
				.mockResolvedValueOnce(asksFor("c1", "get_record", "{}"))
				.mockResolvedValueOnce(answers("I could not find that."));
			executeTool.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });

			const events = await run();

			expect(events[1]).toMatchObject({ type: "tool_result", ok: false, errorCode: "NOT_FOUND" });
			expect(create).toHaveBeenCalledTimes(2);
			expect(typesOf(events)).toContain("done");
		});

		it("reports malformed arguments as a tool failure without executing anything", async () => {
			// Truncated turns produce unparseable JSON. Executing a guess would be
			// worse than telling the model it emitted something invalid.
			create
				.mockResolvedValueOnce(asksFor("c1", "get_record", '{"type":'))
				.mockResolvedValueOnce(answers("retrying"));

			const events = await run();

			expect(executeTool).not.toHaveBeenCalled();
			expect(events[1]).toMatchObject({ type: "tool_result", ok: false, errorCode: "VALIDATION_ERROR" });
		});

		it("stores the provider's call id so the transcript can be replayed", async () => {
			create.mockResolvedValueOnce(asksFor("call_abc", "get_record", "{}")).mockResolvedValueOnce(answers("ok"));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			await run();

			expect(appendAssistantMessage.mock.calls[0][2].toolCalls[0]).toMatchObject({
				provider_call_id: "call_abc",
				tool_name: "get_record",
				status: "ok",
			});
		});

		it("sums usage across every model call in the turn", async () => {
			create
				.mockResolvedValueOnce(asksFor("c1", "get_record", "{}", usage(100, 10)))
				.mockResolvedValueOnce(answers("ok", usage(300, 20)));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			const events = await run();

			expect(events.at(-1)).toMatchObject({ type: "done", usage: { input: 400, output: 30 } });
		});
	});

	describe("approval", () => {
		it("pauses instead of running a gated call, and says which one", async () => {
			create.mockResolvedValueOnce(asksFor("call_1", "reschedule_visit", '{"visit_id":"v1"}'));
			// The ids the approval endpoint takes come back from the write itself.
			appendAssistantMessage.mockResolvedValueOnce({
				id: "am-1",
				created_at: new Date(),
				tool_calls: [
					{
						id: "stored-1",
						provider_call_id: "call_1",
						tool_name: "reschedule_visit",
						input: { visit_id: "v1" },
						status: "pending_approval",
					},
				],
			});

			const events = await run();

			expect(executeTool).not.toHaveBeenCalled();
			const approval = events.find((e) => e.type === "approval_required");
			expect(approval).toMatchObject({
				approvalId: "stored-1",
				id: "call_1",
				name: "reschedule_visit",
				title: "Reschedule a visit",
				summary: expect.any(String),
			});
			// The turn stops rather than calling the model again with a hole in the
			// transcript where the result should be.
			expect(create).toHaveBeenCalledOnce();
			expect(events.at(-1)?.type).toBe("done");
		});

		it("persists the gated call as pending rather than as a result", async () => {
			create.mockResolvedValueOnce(asksFor("c1", "reschedule_visit", "{}"));
			await run();

			expect(appendAssistantMessage.mock.calls[0][2].toolCalls[0]).toMatchObject({
				tool_name: "reschedule_visit",
				status: "pending_approval",
				result: null,
			});
		});

		it("still runs ungated calls in the same batch", async () => {
			// A read that came alongside a gated write has already been permitted to
			// run unattended; holding it hostage to the approval helps nobody.
			create.mockResolvedValueOnce(
				streamOf([completed([callItem("c1", "get_schedule", "{}"), callItem("c2", "reschedule_visit", "{}")])]),
			);
			executeTool.mockResolvedValue({ ok: true, data: {} });

			const events = await run();

			expect(executeTool).toHaveBeenCalledOnce();
			expect(executeTool.mock.calls[0][0]).toBe("get_schedule");
			expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
		});

		it("runs a write that does not require approval", async () => {
			create.mockResolvedValueOnce(asksFor("c1", "add_job_note", "{}")).mockResolvedValueOnce(answers("Noted."));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			await run();

			expect(executeTool).toHaveBeenCalledOnce();
			expect(executeTool.mock.calls[0][0]).toBe("add_job_note");
		});

		it("lapses anything still undecided when the person asks something else", async () => {
			// Approving ten minutes later would fire an action nobody is thinking
			// about any more.
			create.mockResolvedValueOnce(answers("ok"));
			await run();
			expect(expirePendingApprovals).toHaveBeenCalledWith(ctx, "conv-1");
		});
	});

	describe("guards", () => {
		it("reports hitting the output ceiling rather than rendering a blank reply", async () => {
			// Reasoning tokens count against max_output_tokens, so a turn can spend
			// the whole budget thinking and return no text at all. Saying nothing
			// reaches a dispatcher as an empty message with no sign of a problem.
			create.mockResolvedValueOnce(streamOf([incomplete([], "max_output_tokens", usage(900, 8000, 0, 8000))]));

			const events = await run();

			expect(events.some((e) => e.type === "error" && e.code === "OUTPUT_LIMIT")).toBe(true);
			expect(events.at(-1)?.type).toBe("done");
		});

		it("does not run tool calls assembled from a truncated response", async () => {
			// The last call's arguments may have been cut off mid-string.
			create.mockResolvedValueOnce(
				streamOf([incomplete([callItem("c1", "add_job_note", '{"content":"half a sen')], "max_output_tokens")]),
			);

			const events = await run();

			expect(executeTool).not.toHaveBeenCalled();
			expect(events.some((e) => e.type === "error" && e.code === "OUTPUT_LIMIT")).toBe(true);
		});

		it("stops at the iteration limit and says so", async () => {
			// A model that keeps calling tools must not loop forever against a paid API.
			create.mockImplementation(async () => asksFor("c1", "get_record", "{}"));
			executeTool.mockResolvedValue({ ok: true, data: {} });

			const events = await run();

			expect(create.mock.calls.length).toBeLessThanOrEqual(8);
			expect(events.some((e) => e.type === "error" && e.code === "ITERATION_LIMIT")).toBe(true);
			expect(events.at(-1)?.type).toBe("done");
		});

		it("surfaces a provider-side failure instead of finishing silently", async () => {
			create.mockResolvedValueOnce(
				streamOf([{ type: "response.failed", response: { error: { message: "upstream exploded" } } }]),
			);

			await expect(run()).rejects.toThrow(/upstream exploded/);
		});

		it("stops immediately when the client disconnects", async () => {
			const controller = new AbortController();
			controller.abort();
			create.mockResolvedValue(answers("never"));

			const events = await run({ signal: controller.signal });

			expect(events).toEqual([]);
			expect(create).not.toHaveBeenCalled();
		});

		it("stops between tool calls when the client disconnects mid-turn", async () => {
			const controller = new AbortController();
			create.mockResolvedValueOnce(asksFor("c1", "get_record", "{}"));
			executeTool.mockImplementation(async () => {
				controller.abort();
				return { ok: true, data: {} };
			});

			const events = await run({ signal: controller.signal });

			expect(create).toHaveBeenCalledOnce();
			expect(events.some((e) => e.type === "done")).toBe(false);
		});
	});
});
