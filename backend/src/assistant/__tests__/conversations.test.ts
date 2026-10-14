import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));

import { deriveTitle, toTranscript } from "../conversations.js";

type Stored = Parameters<typeof toTranscript>[0][number];

const message = (over: Partial<Stored>): Stored =>
	({
		id: "m",
		role: "user",
		content: "",
		created_at: new Date(),
		input_tokens: null,
		output_tokens: null,
		tool_calls: [],
		...over,
	}) as Stored;

const call = (over: Record<string, unknown> = {}) => ({
	id: "tc",
	provider_call_id: "call_1",
	tool_name: "get_record",
	input: { id: "x" },
	status: "ok",
	result: { ok: true, data: { name: "Acme" } },
	error_code: null,
	duration_ms: 12,
	...over,
});

describe("toTranscript", () => {
	/** Responses items are a flat list, so a call is found by its call_id, not its position. */
	const outputFor = (transcript: ReturnType<typeof toTranscript>, callId: string) =>
		transcript.find((item) => "type" in item && item.type === "function_call_output" && item.call_id === callId) as {
			output: string;
		};
	const typesOf = (transcript: ReturnType<typeof toTranscript>) =>
		transcript.map((item) => ("type" in item ? item.type : `message:${(item as { role: string }).role}`));

	it("replays a plain exchange", () => {
		expect(
			toTranscript([
				message({ role: "user", content: "hi" }),
				message({ role: "assistant", content: "hello" }),
			]),
		).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
	});

	it("pairs each tool result back to the call that asked for it", () => {
		// A function_call_output whose call_id matches no preceding function_call
		// is rejected outright, which is why the provider's id is stored rather
		// than regenerated on replay.
		const transcript = toTranscript([
			message({ role: "assistant", content: "", tool_calls: [call()] as never }),
		]);

		expect(transcript).toEqual([
			{ type: "function_call", call_id: "call_1", name: "get_record", arguments: '{"id":"x"}' },
			{
				type: "function_call_output",
				call_id: "call_1",
				output: JSON.stringify({ ok: true, data: { name: "Acme" } }),
			},
		]);
	});

	it("omits the message entirely for a tool-only assistant turn", () => {
		// Chat Completions needed a null-content assistant message to hang the
		// tool calls off. Responses items stand alone, so an empty one is just noise.
		expect(typesOf(toTranscript([message({ role: "assistant", content: "", tool_calls: [call()] as never })]))).toEqual(
			["function_call", "function_call_output"],
		);
	});

	it("keeps text that accompanied a tool call, ahead of the call", () => {
		const transcript = toTranscript([
			message({ role: "assistant", content: "Let me look.", tool_calls: [call()] as never }),
		]);
		expect(transcript[0]).toEqual({ role: "assistant", content: "Let me look." });
		expect(typesOf(transcript)).toEqual(["message:assistant", "function_call", "function_call_output"]);
	});

	it("emits every call before any result, each paired by id", () => {
		// The API rejects a batch where an output interleaves ahead of a later
		// call in the same turn.
		const transcript = toTranscript([
			message({
				role: "assistant",
				content: "",
				tool_calls: [call({ provider_call_id: "a" }), call({ provider_call_id: "b" })] as never,
			}),
		]);
		expect(typesOf(transcript)).toEqual([
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
		]);
		expect(transcript.map((i) => (i as { call_id: string }).call_id)).toEqual(["a", "b", "a", "b"]);
	});

	it("drops an empty assistant turn that carries nothing", () => {
		expect(toTranscript([message({ role: "assistant", content: "   " })])).toEqual([]);
	});

	it("substitutes a marker when a call has no recorded result", () => {
		// Rather than emitting `null`, which the API rejects for an output item.
		const transcript = toTranscript([
			message({ role: "assistant", content: "", tool_calls: [call({ result: null })] as never }),
		]);
		expect(JSON.parse(outputFor(transcript, "call_1").output)).toMatchObject({ ok: false });
	});

	describe("calls awaiting or refused a decision", () => {
		// Every function_call needs a matching output or the API rejects the whole
		// request — so an undecided call still gets one, saying plainly that it did
		// not run.
		it("tells the model an undecided call has NOT run", () => {
			const transcript = toTranscript([
				message({ role: "assistant", content: "", tool_calls: [call({ status: "pending_approval", result: null })] as never }),
			]);
			const body = JSON.parse(outputFor(transcript, "call_1").output);
			expect(body).toMatchObject({ ok: false, error: { code: "APPROVAL_PENDING" } });
			expect(body.error.message).toMatch(/not run/i);
			expect(body.error.message).toMatch(/do not report it as done/i);
		});

		it("tells the model a refused call was declined and not to retry", () => {
			const transcript = toTranscript([
				message({ role: "assistant", content: "", tool_calls: [call({ status: "rejected", result: null })] as never }),
			]);
			const body = JSON.parse(outputFor(transcript, "call_1").output);
			expect(body.error.code).toBe("REJECTED");
			expect(body.error.message).toMatch(/do not retry/i);
		});

		it("tells the model a lapsed call was cancelled", () => {
			const transcript = toTranscript([
				message({ role: "assistant", content: "", tool_calls: [call({ status: "expired", result: null })] as never }),
			]);
			expect(JSON.parse(outputFor(transcript, "call_1").output).error.code).toBe("EXPIRED");
		});

		it("still emits one output per undecided call", () => {
			const transcript = toTranscript([
				message({
					role: "assistant",
					content: "",
					tool_calls: [
						call({ provider_call_id: "a", status: "pending_approval", result: null }),
						call({ provider_call_id: "b", status: "ok" }),
					] as never,
				}),
			]);
			expect(typesOf(transcript)).toEqual([
				"function_call",
				"function_call",
				"function_call_output",
				"function_call_output",
			]);
		});
	});

	it("preserves a failed call so the model does not retry it blindly", () => {
		const transcript = toTranscript([
			message({
				role: "assistant",
				content: "",
				tool_calls: [call({ status: "error", result: { ok: false, error: { code: "NOT_FOUND" } } })] as never,
			}),
		]);
		expect(outputFor(transcript, "call_1").output).toContain("NOT_FOUND");
	});

	it("carries no reasoning items", () => {
		// Reasoning lives inside a single turn, in memory in the loop. Nothing
		// encrypted is persisted, so nothing encrypted can be replayed from here.
		const transcript = toTranscript([
			message({ role: "assistant", content: "thinking done", tool_calls: [call()] as never }),
		]);
		expect(transcript.some((item) => "type" in item && item.type === "reasoning")).toBe(false);
	});
});

describe("deriveTitle", () => {
	it("uses a short question verbatim", () => {
		expect(deriveTitle("What is on for Tuesday?")).toBe("What is on for Tuesday?");
	});

	it("collapses whitespace", () => {
		expect(deriveTitle("  what   is\n on? ")).toBe("what is on?");
	});

	it("truncates a long opener", () => {
		const title = deriveTitle("x".repeat(200));
		expect(title).toHaveLength(58);
		expect(title.endsWith("…")).toBe(true);
	});

	it("falls back rather than producing an empty title", () => {
		expect(deriveTitle("   ")).toBe("New conversation");
	});
});
