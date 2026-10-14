import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../axiosClient", () => ({ api: { get: apiGet } }));

import { AssistantStreamError, resolveApproval, streamAssistantTurn } from "../assistant";
import type { AssistantEvent } from "../../types/assistant";

/** Build a Response whose body streams the given SSE text, in arbitrary chunks. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(body, { status: 200, ...init });
}

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/** Typed so `mock.calls[n][1]` stays indexable — an untyped vi.fn() infers a zero-length tuple. */
const makeFetchMock = (responses: Response[]) =>
	vi.fn(async (_url: string, _init: RequestInit) => responses.shift()!);

const collect = async (response: Response | Response[], message = "hi") => {
	const events: AssistantEvent[] = [];
	const fetchMock = makeFetchMock(Array.isArray(response) ? [...response] : [response]);
	vi.stubGlobal("fetch", fetchMock);

	await streamAssistantTurn({
		message,
		onEvent: (e) => events.push(e),
		signal: new AbortController().signal,
	});
	return { events, fetchMock };
};

describe("streamAssistantTurn", () => {
	beforeEach(() => {
		apiGet.mockReset();
		vi.unstubAllGlobals();
	});

	it("dispatches each event in order", async () => {
		const { events } = await collect(
			sseResponse([
				frame({ type: "conversation", id: "c1", title: null }),
				frame({ type: "text_delta", text: "Two " }),
				frame({ type: "text_delta", text: "visits." }),
				frame({ type: "done", messageId: "m1", usage: null }),
			]),
		);

		expect(events.map((e) => e.type)).toEqual(["conversation", "text_delta", "text_delta", "done"]);
	});

	it("reassembles frames split across network chunks", async () => {
		// A frame does not arrive whole; the parser has to buffer until "\n\n".
		const { events } = await collect(
			sseResponse(['data: {"type":"text_', 'delta","text":"hello"}\n', "\n", frame({ type: "done", messageId: null, usage: null })]),
		);

		expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
		expect(events).toHaveLength(2);
	});

	it("handles several frames arriving in one chunk", async () => {
		const { events } = await collect(
			sseResponse([frame({ type: "text_delta", text: "a" }) + frame({ type: "text_delta", text: "b" })]),
		);
		expect(events).toHaveLength(2);
	});

	it("ignores heartbeat comments", async () => {
		const { events } = await collect(sseResponse([": ping\n\n", frame({ type: "text_delta", text: "x" }), ": ping\n\n"]));
		expect(events).toEqual([{ type: "text_delta", text: "x" }]);
	});

	it("skips an unparseable frame rather than tearing down the stream", async () => {
		const { events } = await collect(
			sseResponse(["data: {not json}\n\n", frame({ type: "done", messageId: null, usage: null })]),
		);
		expect(events).toEqual([{ type: "done", messageId: null, usage: null }]);
	});

	it("sends the conversation id when continuing an existing thread", async () => {
		const fetchMock = makeFetchMock([sseResponse([frame({ type: "done", messageId: null, usage: null })])]);
		vi.stubGlobal("fetch", fetchMock);

		await streamAssistantTurn({
			message: "hi",
			conversationId: "conv-9",
			onEvent: () => {},
			signal: new AbortController().signal,
		});

		expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
			message: "hi",
			conversation_id: "conv-9",
		});
	});

	it("omits the conversation id when starting fresh", async () => {
		const { fetchMock } = await collect(sseResponse([frame({ type: "done", messageId: null, usage: null })]));
		expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ message: "hi" });
	});

	describe("auth", () => {
		it("refreshes once through axios and retries on 401", async () => {
			// The axios interceptor owns the refresh queue; duplicating it here would
			// mean two implementations that can disagree about when to redirect.
			localStorage.setItem("accessToken", "stale");
			apiGet.mockImplementation(async () => {
				localStorage.setItem("accessToken", "fresh");
				return { data: { data: {} } };
			});

			const { fetchMock } = await collect([
				new Response(null, { status: 401 }),
				sseResponse([frame({ type: "done", messageId: null, usage: null })]),
			]);

			expect(apiGet).toHaveBeenCalledOnce();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer fresh");
		});

		it("gives up when the refresh itself fails", async () => {
			apiGet.mockRejectedValue(new Error("refresh failed"));
			vi.stubGlobal("fetch", makeFetchMock([new Response(null, { status: 401 })]));

			await expect(
				streamAssistantTurn({ message: "hi", onEvent: () => {}, signal: new AbortController().signal }),
			).rejects.toThrow(/session expired/i);
		});
	});

	describe("failures", () => {
		it("surfaces the API's own error message", async () => {
			vi.stubGlobal(
				"fetch",
				makeFetchMock([
					new Response(JSON.stringify({ error: { message: "Assistant is not configured." } }), { status: 503 }),
				]),
			);

			await expect(
				streamAssistantTurn({ message: "hi", onEvent: () => {}, signal: new AbortController().signal }),
			).rejects.toThrow("Assistant is not configured.");
		});

		it("explains a 429 in terms a person can act on", async () => {
			vi.stubGlobal("fetch", makeFetchMock([new Response("nope", { status: 429 })]));

			await expect(
				streamAssistantTurn({ message: "hi", onEvent: () => {}, signal: new AbortController().signal }),
			).rejects.toThrow(/already have a reply in flight/i);
		});

		it("shows the server's monthly-limit sentence on QUOTA_EXCEEDED", async () => {
			vi.stubGlobal(
				"fetch",
				makeFetchMock([
					new Response(
						JSON.stringify({
							error: {
								code: "QUOTA_EXCEEDED",
								message: "Monthly AI assistant limit reached. It resets on the 1st (UTC).",
							},
						}),
						{ status: 429 },
					),
				]),
			);

			await expect(
				streamAssistantTurn({ message: "hi", onEvent: () => {}, signal: new AbortController().signal }),
			).rejects.toThrow("Monthly AI assistant limit reached. It resets on the 1st (UTC).");
		});

		it("throws an AssistantStreamError carrying the status", async () => {
			vi.stubGlobal("fetch", makeFetchMock([new Response("x", { status: 500 })]));

			await streamAssistantTurn({
				message: "hi",
				onEvent: () => {},
				signal: new AbortController().signal,
			}).catch((err) => {
				expect(err).toBeInstanceOf(AssistantStreamError);
				expect((err as AssistantStreamError).status).toBe(500);
			});
			expect.assertions(2);
		});
	});
});

describe("resolveApproval", () => {
	beforeEach(() => {
		apiGet.mockReset();
		vi.unstubAllGlobals();
	});

	it("posts the decision to the approval endpoint", async () => {
		const fetchMock = makeFetchMock([sseResponse([frame({ type: "done", messageId: null, usage: null })])]);
		vi.stubGlobal("fetch", fetchMock);

		await resolveApproval({
			approvalId: "approval-1",
			decision: "approve",
			onEvent: () => {},
			signal: new AbortController().signal,
		});

		expect(String(fetchMock.mock.calls[0][0])).toContain("/assistant/approvals/approval-1");
		expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ decision: "approve" });
	});

	it("streams the resumed turn back", async () => {
		const events: AssistantEvent[] = [];
		vi.stubGlobal(
			"fetch",
			makeFetchMock([
				sseResponse([
					frame({ type: "approval_resolved", approvalId: "approval-1", id: "call_1", approved: true }),
					frame({ type: "text_delta", text: "Done." }),
					frame({ type: "done", messageId: "m2", usage: null }),
				]),
			]),
		);

		await resolveApproval({
			approvalId: "approval-1",
			decision: "approve",
			onEvent: (e) => events.push(e),
			signal: new AbortController().signal,
		});

		expect(events.map((e) => e.type)).toEqual(["approval_resolved", "text_delta", "done"]);
	});

	it("surfaces a conflict when the action was already decided", async () => {
		// Two tabs, one pending action: the second decision has to say so rather
		// than silently doing nothing.
		vi.stubGlobal(
			"fetch",
			makeFetchMock([
				new Response(JSON.stringify({ error: { message: "That action was already decided." } }), {
					status: 409,
				}),
			]),
		);

		await expect(
			resolveApproval({
				approvalId: "approval-1",
				decision: "approve",
				onEvent: () => {},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("That action was already decided.");
	});
});
