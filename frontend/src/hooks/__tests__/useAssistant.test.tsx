import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { streamAssistantTurn, getConversationMessages, getPendingApprovals, resolveApproval } = vi.hoisted(() => ({
	streamAssistantTurn: vi.fn(),
	getConversationMessages: vi.fn(),
	getPendingApprovals: vi.fn(async () => [] as unknown[]),
	resolveApproval: vi.fn(),
}));

vi.mock("../../api/assistant", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../api/assistant")>()),
	streamAssistantTurn,
	getConversationMessages,
	getPendingApprovals,
	resolveApproval,
	getAssistantStatus: vi.fn(),
	listConversations: vi.fn(),
}));

import { useAssistantChat } from "../useAssistant";
import type { AssistantEvent, UiMessage } from "../../types/assistant";

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

/** Drive the hook by replaying a scripted event sequence through the stream stub. */
const scripted = (events: AssistantEvent[]) =>
	streamAssistantTurn.mockImplementation(async (opts: { onEvent: (e: AssistantEvent) => void }) => {
		for (const event of events) opts.onEvent(event);
	});

const assistantMessage = (messages: UiMessage[]) => messages.find((m) => m.role === "assistant");

describe("useAssistantChat", () => {
	beforeEach(() => {
		streamAssistantTurn.mockReset();
		getConversationMessages.mockReset();
		resolveApproval.mockReset();
		getPendingApprovals.mockReset();
		getPendingApprovals.mockResolvedValue([]);
	});

	it("shows the user's message immediately, before the model replies", async () => {
		scripted([{ type: "done", messageId: "m1", usage: null }]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		await act(() => result.current.send("what's on tuesday?"));

		expect(result.current.messages[0]).toMatchObject({ role: "user", content: "what's on tuesday?" });
	});

	it("accumulates streamed text into one assistant message", async () => {
		scripted([
			{ type: "text_delta", text: "Two " },
			{ type: "text_delta", text: "visits." },
			{ type: "done", messageId: "m1", usage: null },
		]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		await act(() => result.current.send("hi"));

		expect(assistantMessage(result.current.messages)).toMatchObject({
			content: "Two visits.",
			streaming: false,
		});
	});

	it("adopts the conversation id the server assigns", async () => {
		scripted([
			{ type: "conversation", id: "conv-7", title: "hi" },
			{ type: "done", messageId: "m1", usage: null },
		]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		await act(() => result.current.send("hi"));

		expect(result.current.conversationId).toBe("conv-7");
	});

	it("continues the same conversation on the next message", async () => {
		scripted([
			{ type: "conversation", id: "conv-7", title: null },
			{ type: "done", messageId: "m1", usage: null },
		]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		await act(() => result.current.send("first"));
		await act(() => result.current.send("second"));

		expect(streamAssistantTurn.mock.calls[1][0].conversationId).toBe("conv-7");
	});

	describe("tool calls", () => {
		it("renders a call as running, then resolves it in place", async () => {
			scripted([
				{ type: "tool_call", id: "t1", name: "get_schedule", input: { start_date: "2026-08-25" } },
				{ type: "tool_result", id: "t1", ok: true, summary: "Read the schedule — 3 visits", durationMs: 42 },
				{ type: "text_delta", text: "Three visits." },
				{ type: "done", messageId: "m1", usage: null },
			]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			const message = assistantMessage(result.current.messages);
			expect(message).toMatchObject({ content: "Three visits." });
			expect(message?.role === "assistant" && message.toolCalls).toEqual([
				{
					id: "t1",
					name: "get_schedule",
					input: { start_date: "2026-08-25" },
					state: "ok",
					summary: "Read the schedule — 3 visits",
					errorMessage: undefined,
					durationMs: 42,
				},
			]);
		});

		it("marks a failed call without discarding the turn", async () => {
			scripted([
				{ type: "tool_call", id: "t1", name: "get_record", input: {} },
				{
					type: "tool_result",
					id: "t1",
					ok: false,
					summary: "get_record failed",
					errorCode: "NOT_FOUND",
					errorMessage: "gone",
					durationMs: 5,
				},
				{ type: "text_delta", text: "I could not find that." },
				{ type: "done", messageId: "m1", usage: null },
			]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			const message = assistantMessage(result.current.messages);
			expect(message?.role === "assistant" && message.toolCalls[0]).toMatchObject({
				state: "error",
				errorMessage: "gone",
			});
			expect(message).toMatchObject({ content: "I could not find that." });
		});

		it("keeps several calls from one turn distinct", async () => {
			scripted([
				{ type: "tool_call", id: "a", name: "search_records", input: {} },
				{ type: "tool_call", id: "b", name: "get_record", input: {} },
				{ type: "tool_result", id: "b", ok: true, summary: "second", durationMs: 1 },
				{ type: "tool_result", id: "a", ok: true, summary: "first", durationMs: 2 },
				{ type: "done", messageId: "m1", usage: null },
			]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			const message = assistantMessage(result.current.messages);
			// Results can arrive out of order; each must land on its own call.
			expect(message?.role === "assistant" && message.toolCalls.map((c) => c.summary)).toEqual(["first", "second"]);
		});
	});

	describe("approvals", () => {
		const pendingEvents: AssistantEvent[] = [
			{ type: "text_delta", text: "I can move that." },
			{
				type: "approval_required",
				approvalId: "approval-1",
				id: "call_1",
				name: "reschedule_visit",
				title: "Reschedule a visit",
				summary: "Move this visit to 2026-09-01 09:30",
				input: { visit_id: "v1" },
			},
			{ type: "done", messageId: "m1", usage: null },
		];

		it("renders a pending action rather than reporting it as done", async () => {
			scripted(pendingEvents);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("move the miller visit"));

			const message = assistantMessage(result.current.messages);
			expect(message?.role === "assistant" && message.toolCalls[0]).toMatchObject({
				id: "call_1",
				approvalId: "approval-1",
				state: "awaiting_approval",
				summary: "Move this visit to 2026-09-01 09:30",
			});
			expect(result.current.streaming).toBe(false);
		});

		it("sends the decision and settles the card on approval", async () => {
			scripted(pendingEvents);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });
			await act(() => result.current.send("move it"));

			resolveApproval.mockImplementation(async (opts: { onEvent: (e: AssistantEvent) => void }) => {
				opts.onEvent({ type: "approval_resolved", approvalId: "approval-1", id: "call_1", approved: true });
				opts.onEvent({
					type: "tool_result",
					id: "call_1",
					ok: true,
					summary: "Moved the visit",
					durationMs: 30,
				});
				opts.onEvent({ type: "text_delta", text: " Done." });
				opts.onEvent({ type: "done", messageId: "m2", usage: null });
			});

			await act(() => result.current.decide("approval-1", "approve"));

			expect(resolveApproval.mock.calls[0][0]).toMatchObject({
				approvalId: "approval-1",
				decision: "approve",
			});
			const message = assistantMessage(result.current.messages);
			expect(message?.role === "assistant" && message.toolCalls[0]).toMatchObject({
				state: "ok",
				summary: "Moved the visit",
				approvalId: undefined,
			});
			expect(message).toMatchObject({ content: "I can move that. Done." });
		});

		it("marks the card declined when the person says no", async () => {
			scripted(pendingEvents);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });
			await act(() => result.current.send("move it"));

			resolveApproval.mockImplementation(async (opts: { onEvent: (e: AssistantEvent) => void }) => {
				opts.onEvent({ type: "approval_resolved", approvalId: "approval-1", id: "call_1", approved: false });
				opts.onEvent({
					type: "tool_result",
					id: "call_1",
					ok: false,
					summary: "Declined",
					errorCode: "REJECTED",
					errorMessage: "You declined this action.",
					durationMs: 0,
				});
				opts.onEvent({ type: "done", messageId: "m2", usage: null });
			});

			await act(() => result.current.decide("approval-1", "reject"));

			const message = assistantMessage(result.current.messages);
			expect(message?.role === "assistant" && message.toolCalls[0]).toMatchObject({
				state: "error",
				errorMessage: "You declined this action.",
			});
		});

		it("does not decide while a turn is already streaming", async () => {
			let release: (() => void) | undefined;
			streamAssistantTurn.mockImplementation(() => new Promise<void>((r) => { release = r; }));
			const { result } = renderHook(() => useAssistantChat(), { wrapper });
			act(() => void result.current.send("hi"));
			await waitFor(() => expect(result.current.streaming).toBe(true));

			await act(() => result.current.decide("approval-1", "approve"));

			expect(resolveApproval).not.toHaveBeenCalled();
			await act(async () => release?.());
		});

		it("restores a pending action after a reload, with its approval id", async () => {
			// The message row stores the provider's call id; the buttons need ours.
			getConversationMessages.mockResolvedValue([
				{
					id: "m1",
					role: "assistant",
					content: "I can move that.",
					created_at: "",
					input_tokens: null,
					output_tokens: null,
					tool_calls: [
						{
							id: "x",
							provider_call_id: "call_1",
							tool_name: "reschedule_visit",
							input: {},
							status: "pending_approval",
							result: null,
							error_code: null,
							duration_ms: null,
						},
					],
				},
			]);
			getPendingApprovals.mockResolvedValue([
				{
					approvalId: "approval-1",
					id: "call_1",
					name: "reschedule_visit",
					title: "Reschedule a visit",
					summary: "Move this visit",
					input: {},
				},
			]);

			const { result } = renderHook(() => useAssistantChat(), { wrapper });
			await act(() => result.current.openConversation("conv-3"));

			const message = result.current.messages[0];
			expect(message.role === "assistant" && message.toolCalls[0]).toMatchObject({
				state: "awaiting_approval",
				approvalId: "approval-1",
				summary: "Move this visit",
			});
		});

		it.each([
			["rejected", "declined"],
			["expired", "error"],
			["ok", "ok"],
		])("renders a stored %s call as %s", async (status, expected) => {
			getConversationMessages.mockResolvedValue([
				{
					id: "m1",
					role: "assistant",
					content: "",
					created_at: "",
					input_tokens: null,
					output_tokens: null,
					tool_calls: [
						{
							id: "x",
							provider_call_id: "c",
							tool_name: "reschedule_visit",
							input: {},
							status,
							result: null,
							error_code: null,
							duration_ms: null,
						},
					],
				},
			]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });
			await act(() => result.current.openConversation("conv-3"));

			const message = result.current.messages[0];
			expect(message.role === "assistant" && message.toolCalls[0].state).toBe(expected);
		});
	});

	describe("errors", () => {
		it("renders a server error event in the thread", async () => {
			scripted([{ type: "error", message: "Something went wrong." }]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			expect(result.current.messages.at(-1)).toMatchObject({ role: "error", content: "Something went wrong." });
			expect(result.current.streaming).toBe(false);
		});

		it("does not leave an empty bubble above the error", async () => {
			scripted([{ type: "error", message: "boom" }]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			expect(result.current.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
		});

		it("keeps partial output when the turn fails midway", async () => {
			scripted([{ type: "text_delta", text: "Half an ans" }, { type: "error", message: "connection lost" }]);
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			expect(assistantMessage(result.current.messages)).toMatchObject({ content: "Half an ans" });
			expect(result.current.messages.at(-1)).toMatchObject({ role: "error" });
		});

		it("reports a thrown transport failure in plain language", async () => {
			streamAssistantTurn.mockRejectedValue(new Error("network down"));
			const { result } = renderHook(() => useAssistantChat(), { wrapper });

			await act(() => result.current.send("hi"));

			expect(result.current.messages.at(-1)).toMatchObject({
				role: "error",
				content: expect.stringContaining("Could not reach the assistant"),
			});
		});
	});

	it("refuses to send while a turn is already streaming", async () => {
		// The server caps concurrency too; this stops the client asking for a 429.
		let release: (() => void) | undefined;
		streamAssistantTurn.mockImplementation(
			() => new Promise<void>((resolve) => { release = resolve; }),
		);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		act(() => void result.current.send("first"));
		await waitFor(() => expect(result.current.streaming).toBe(true));
		await act(() => result.current.send("second"));

		expect(streamAssistantTurn).toHaveBeenCalledOnce();
		await act(async () => release?.());
	});

	it("clears the thread and the conversation id on startNew", async () => {
		scripted([
			{ type: "conversation", id: "conv-7", title: null },
			{ type: "text_delta", text: "hi" },
			{ type: "done", messageId: "m1", usage: null },
		]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });
		await act(() => result.current.send("hi"));

		act(() => result.current.startNew());

		expect(result.current.messages).toEqual([]);
		expect(result.current.conversationId).toBeNull();
	});

	it("loads a past conversation into the thread", async () => {
		getConversationMessages.mockResolvedValue([
			{ id: "m1", role: "user", content: "earlier", created_at: "", input_tokens: null, output_tokens: null, tool_calls: [] },
			{
				id: "m2",
				role: "assistant",
				content: "answer",
				created_at: "",
				input_tokens: null,
				output_tokens: null,
				tool_calls: [
					{
						id: "x",
						provider_call_id: "call_1",
						tool_name: "get_schedule",
						input: {},
						status: "ok",
						result: {},
						error_code: null,
						duration_ms: 9,
					},
				],
			},
		]);
		const { result } = renderHook(() => useAssistantChat(), { wrapper });

		await act(() => result.current.openConversation("conv-3"));

		expect(result.current.conversationId).toBe("conv-3");
		expect(result.current.messages).toHaveLength(2);
		const message = result.current.messages[1];
		expect(message.role === "assistant" && message.toolCalls[0]).toMatchObject({
			id: "call_1",
			name: "get_schedule",
			state: "ok",
		});
	});
});
