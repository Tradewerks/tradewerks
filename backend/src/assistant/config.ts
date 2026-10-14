/**
 * Assistant configuration.
 *
 * The provider is OpenAI, reached through the Responses API. Chat Completions
 * was the original choice and is no longer viable: the GPT-5.6 family rejects a
 * request that carries function tools together with any `reasoning_effort`
 * above `none`, and it defaults to `medium`, so the call fails even when the
 * parameter is never sent. Responses is also where reasoning items can be
 * carried across a tool call, which is exactly what this loop does.
 *
 * The model is an environment variable with no clever default-picking: naming a
 * model in code that the account cannot access fails at the worst moment, in
 * front of a user mid-sentence. Set OPENAI_MODEL deliberately.
 */

import type { ReasoningEffort } from "openai/resources/shared";

/**
 * Default is Luna, the cheap tier of the GPT-5.6 family.
 *
 * This workload is short-context — a ~6k fixed prefix, capped lists, and at most
 * MAX_TOOL_ITERATIONS round trips — so Luna's one hard limitation, long-context
 * recall collapsing past ~256k tokens, is out of reach here. Escalate to
 * gpt-5.6-terra if the decline rate on approvals or the iteration_limit rate
 * says the reasoning is not enough; both are already exported as metrics.
 */
export const ASSISTANT_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * How hard the model thinks before it answers or calls a tool.
 *
 * "low" is the default because most turns here are a lookup and a sentence, and
 * reasoning tokens bill at the output rate. Raise it for an organization whose
 * dispatchers ask multi-step questions; an unrecognised value falls back rather
 * than failing the request, since a typo in an env var should not take the
 * assistant offline.
 */
export const REASONING_EFFORT: ReasoningEffort = (() => {
	const configured = process.env.ASSISTANT_REASONING_EFFORT;
	return (REASONING_EFFORTS as readonly string[]).includes(configured ?? "")
		? (configured as ReasoningEffort)
		: "low";
})();

/** Hard ceiling on model→tool→model round trips inside one user turn. */
export const MAX_TOOL_ITERATIONS = Number(process.env.ASSISTANT_MAX_ITERATIONS) || 6;

/** Turns of history replayed to the model. Older turns are dropped from the tail. */
export const HISTORY_WINDOW = Number(process.env.ASSISTANT_HISTORY_WINDOW) || 40;

/**
 * Upper bound on a single response.
 *
 * This counts reasoning tokens as well as visible ones, so it cannot be sized
 * against the answer alone: a turn that spends the whole budget thinking
 * returns no text at all. The old 2000 was set for a non-reasoning model and is
 * too tight for one that thinks first — hence 8000, and hence the explicit
 * truncation handling in `loop.ts`, which reports the ceiling rather than
 * emitting a blank reply.
 */
export const MAX_OUTPUT_TOKENS =
	Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS || process.env.ASSISTANT_MAX_COMPLETION_TOKENS) || 8000;

/**
 * Concurrent streams one user may hold open.
 *
 * Not a full rate limiter — that is Phase 5 — but an open SSE stream drives a
 * paid API in a loop, and a stuck retry loop in a browser tab should not be able
 * to open fifty of them.
 */
export const MAX_CONCURRENT_STREAMS_PER_USER = Number(process.env.ASSISTANT_MAX_CONCURRENT_STREAMS) || 3;

/** Longest a single turn may run before the server gives up on it. */
export const TURN_TIMEOUT_MS = Number(process.env.ASSISTANT_TURN_TIMEOUT_MS) || 120_000;

/**
 * Whether the assistant may propose changes at all.
 *
 * "Writes enabled" is narrower than it sounds. Every scheduling tool requires an
 * explicit human approval before it runs, so this flag governs whether those
 * tools are advertised to the model — not whether it can act unattended. It
 * cannot: the executor refuses an unapproved call regardless of this setting.
 *
 * Set ASSISTANT_WRITES_ENABLED=false to run the assistant read-only.
 */
export const areWritesEnabled = (): boolean => process.env.ASSISTANT_WRITES_ENABLED !== "false";

export const isAssistantEnabled = (): boolean => Boolean(process.env.OPENAI_API_KEY);

/** Why the assistant is unavailable, in words a dispatcher can act on. */
export const assistantUnavailableReason = (): string | null =>
	isAssistantEnabled() ? null : "The assistant is not configured on this server yet.";
