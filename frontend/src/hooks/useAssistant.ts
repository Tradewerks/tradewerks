/**
 * Assistant state for the panel.
 *
 * Conversation metadata is server state and lives in TanStack Query. The active
 * turn is not — it is a stream of deltas that only exists while it is arriving —
 * so it lives in a reducer here and is reconciled against the server when the
 * conversation is next loaded.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import {
	AssistantStreamError,
	getAssistantStatus,
	getConversationMessages,
	getPendingApprovals,
	listConversations,
	resolveApproval,
	streamAssistantTurn,
} from "../api/assistant";
import type { AssistantEvent, PendingApproval, StoredMessage, UiMessage, UiToolCall } from "../types/assistant";

const useQuery = moduleQuery("ai_assistant");

const assistantRoot = ["assistant"] as const;

export const assistantKeys = {
	all: assistantRoot,
	status: [...assistantRoot, "status"] as const,
	conversations: [...assistantRoot, "conversations"] as const,
	messages: (id: string) => [...assistantRoot, "conversation", id, "messages"] as const,
	approvals: (id: string) => [...assistantRoot, "conversation", id, "approvals"] as const,
};

export function useAssistantStatus() {
	return useQuery({
		queryKey: assistantKeys.status,
		queryFn: getAssistantStatus,
		// Whether the server has a key configured does not change minute to minute.
		staleTime: 5 * 60 * 1000,
	});
}

export function useAssistantConversations(enabled: boolean) {
	return useQuery({
		queryKey: assistantKeys.conversations,
		queryFn: listConversations,
		enabled,
	});
}

// ── Turn state ──────────────────────────────────────────────────────────────

interface TurnState {
	messages: UiMessage[];
	streaming: boolean;
}

type TurnAction =
	| { kind: "reset"; messages: UiMessage[] }
	| { kind: "user"; content: string }
	| { kind: "start" }
	/** Continue after an approval: no new bubble, the existing thread carries on. */
	| { kind: "resume" }
	| { kind: "event"; event: AssistantEvent }
	| { kind: "fail"; message: string };

/** Ids for optimistic rows, distinct from server ids so reconciliation is obvious. */
let localId = 0;
const nextLocalId = () => `local-${++localId}`;

/** Apply a change to the in-flight assistant message, which is always the last one. */
function updateStreaming(messages: UiMessage[], change: (m: Extract<UiMessage, { role: "assistant" }>) => void) {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant" || !last.streaming) return messages;
	const clone = { ...last, toolCalls: [...last.toolCalls] };
	change(clone);
	return [...messages.slice(0, -1), clone];
}

function turnReducer(state: TurnState, action: TurnAction): TurnState {
	switch (action.kind) {
		case "reset":
			return { messages: action.messages, streaming: false };

		case "user":
			return {
				...state,
				messages: [...state.messages, { id: nextLocalId(), role: "user", content: action.content }],
			};

		case "start":
			return {
				streaming: true,
				messages: [
					...state.messages,
					{ id: nextLocalId(), role: "assistant", content: "", toolCalls: [], streaming: true },
				],
			};

		case "resume":
			// Reopen the last assistant message so text deltas from the resumed turn
			// land on it rather than creating a stray bubble.
			return {
				streaming: true,
				messages: state.messages.map((m, i): UiMessage =>
					m.role === "assistant" && i === state.messages.length - 1 ? { ...m, streaming: true } : m,
				),
			};

		case "fail": {
			const settled = state.messages
				// Drop an empty placeholder rather than leaving a blank bubble above the error.
				.filter((m) => !(m.role === "assistant" && m.streaming && !m.content && !m.toolCalls.length))
				.map((m): UiMessage => (m.role === "assistant" ? { ...m, streaming: false } : m));
			return {
				streaming: false,
				messages: [...settled, { id: nextLocalId(), role: "error", content: action.message }],
			};
		}

		case "event": {
			const event = action.event;
			switch (event.type) {
				case "text_delta":
					return {
						...state,
						messages: updateStreaming(state.messages, (m) => {
							m.content += event.text;
						}),
					};

				case "tool_call":
					return {
						...state,
						messages: updateStreaming(state.messages, (m) => {
							m.toolCalls.push({
								id: event.id,
								name: event.name,
								input: event.input,
								state: "running",
							} satisfies UiToolCall);
						}),
					};

				case "tool_result":
					// Searched across every message, not just the streaming one: a
					// resumed turn settles a call that belongs to an earlier message.
					return {
						...state,
						messages: state.messages.map((m): UiMessage =>
							m.role === "assistant" && m.toolCalls.some((c) => c.id === event.id)
								? {
										...m,
										toolCalls: m.toolCalls.map((call) =>
											call.id === event.id
												? {
														...call,
														state: event.ok ? "ok" : "error",
														summary: event.summary,
														errorMessage: event.errorMessage,
														durationMs: event.durationMs,
														approvalId: undefined,
													}
												: call,
										),
									}
								: m,
						),
					};

				case "approval_required":
					return {
						...state,
						messages: updateStreaming(state.messages, (m) => {
							const existing = m.toolCalls.find((c) => c.id === event.id);
							const pending: UiToolCall = {
								id: event.id,
								name: event.name,
								title: event.title,
								input: event.input,
								state: "awaiting_approval",
								summary: event.summary,
								approvalId: event.approvalId,
							};
							// The loop announces a gated call without a preceding tool_call
							// event, so this usually adds rather than updates.
							m.toolCalls = existing
								? m.toolCalls.map((c) => (c.id === event.id ? pending : c))
								: [...m.toolCalls, pending];
						}),
					};

				case "approval_resolved":
					return {
						...state,
						messages: state.messages.map((m): UiMessage =>
							m.role === "assistant"
								? {
										...m,
										toolCalls: m.toolCalls.map((c) =>
											c.approvalId === event.approvalId
												? {
														...c,
														state: event.approved ? "running" : "declined",
														approvalId: undefined,
													}
												: c,
										),
									}
								: m,
						),
					};

				case "error":
					return turnReducer(state, { kind: "fail", message: event.message });

				case "done":
					return {
						streaming: false,
						messages: state.messages.map((m): UiMessage =>
							m.role === "assistant" ? { ...m, streaming: false } : m,
						),
					};

				default:
					return state;
			}
		}

		default:
			return state;
	}
}

/** Stored status → the state the card renders in. */
function stateForStatus(status: string): UiToolCall["state"] {
	switch (status) {
		case "ok":
			return "ok";
		case "pending_approval":
			return "awaiting_approval";
		case "rejected":
			return "declined";
		default:
			// "error" and "expired" both read as a call that did not succeed; the
			// stored result carries the distinction for anyone who expands the card.
			return "error";
	}
}

/**
 * Server rows → the panel's message shape.
 *
 * `pending` supplies the approval ids for calls still awaiting a decision. They
 * live on a separate endpoint because the message row stores the provider's call
 * id, and the approval endpoint takes our own — reloading a conversation with a
 * pending action has to recover the latter or the buttons would do nothing.
 */
function fromStored(rows: StoredMessage[], pending: PendingApproval[] = []): UiMessage[] {
	const approvalByCallId = new Map(pending.map((p) => [p.id, p]));

	return rows.map((row): UiMessage => {
		if (row.role === "user") return { id: row.id, role: "user", content: row.content };
		return {
			id: row.id,
			role: "assistant",
			content: row.content,
			streaming: false,
			toolCalls: row.tool_calls.map((call): UiToolCall => {
				const waiting = approvalByCallId.get(call.provider_call_id);
				return {
					id: call.provider_call_id,
					name: call.tool_name,
					input: call.input,
					state: stateForStatus(call.status),
					durationMs: call.duration_ms ?? undefined,
					...(waiting
						? { approvalId: waiting.approvalId, summary: waiting.summary, title: waiting.title }
						: {}),
				};
			}),
		};
	});
}

export function useAssistantChat() {
	const queryClient = useQueryClient();
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [state, dispatch] = useReducer(turnReducer, { messages: [], streaming: false });
	const abortRef = useRef<AbortController | null>(null);

	// Abort any in-flight turn when the panel unmounts, so a closed drawer stops
	// costing tokens.
	useEffect(() => () => abortRef.current?.abort(), []);

	const openConversation = useCallback(
		async (id: string | null) => {
			abortRef.current?.abort();
			setConversationId(id);
			if (!id) {
				dispatch({ kind: "reset", messages: [] });
				return;
			}
			const [rows, pending] = await Promise.all([
				queryClient.fetchQuery({
					queryKey: assistantKeys.messages(id),
					queryFn: () => getConversationMessages(id),
				}),
				queryClient.fetchQuery({
					queryKey: assistantKeys.approvals(id),
					queryFn: () => getPendingApprovals(id),
				}),
			]);
			dispatch({ kind: "reset", messages: fromStored(rows, pending) });
		},
		[queryClient],
	);

	const send = useCallback(
		async (message: string) => {
			const text = message.trim();
			if (!text || state.streaming) return;

			const controller = new AbortController();
			abortRef.current = controller;

			dispatch({ kind: "user", content: text });
			dispatch({ kind: "start" });

			let activeId = conversationId;

			try {
				await streamAssistantTurn({
					message: text,
					conversationId: activeId ?? undefined,
					signal: controller.signal,
					onEvent: (event) => {
						if (event.type === "conversation") {
							activeId = event.id;
							setConversationId(event.id);
							return;
						}
						if (event.type === "invalidate") {
							// Inert while the assistant is read-only; wired so Phase 3's
							// write tools refresh the pages they changed.
							for (const key of event.keys) {
								queryClient.invalidateQueries({ queryKey: [key.split(":")[0]] });
							}
							return;
						}
						dispatch({ kind: "event", event });
					},
				});
			} catch (err) {
				if (controller.signal.aborted) return;
				dispatch({
					kind: "fail",
					message:
						err instanceof AssistantStreamError
							? err.message
							: "Could not reach the assistant. Check your connection and try again.",
				});
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				queryClient.invalidateQueries({ queryKey: assistantKeys.conversations });
				if (activeId) queryClient.invalidateQueries({ queryKey: assistantKeys.messages(activeId) });
			}
		},
		[conversationId, queryClient, state.streaming],
	);

	/**
	 * Approve or decline one pending action.
	 *
	 * Shares the streaming plumbing with `send`, because the response is the same
	 * shape — the outcome of the decision, then the model's continuation once
	 * nothing else in the conversation is waiting.
	 */
	const decide = useCallback(
		async (approvalId: string, decision: "approve" | "reject") => {
			if (state.streaming) return;

			const controller = new AbortController();
			abortRef.current = controller;
			dispatch({ kind: "resume" });

			try {
				await resolveApproval({
					approvalId,
					decision,
					signal: controller.signal,
					onEvent: (event) => {
						if (event.type === "invalidate") {
							for (const key of event.keys) {
								queryClient.invalidateQueries({ queryKey: [key.split(":")[0]] });
							}
							return;
						}
						dispatch({ kind: "event", event });
					},
				});
			} catch (err) {
				if (controller.signal.aborted) return;
				dispatch({
					kind: "fail",
					message:
						err instanceof AssistantStreamError
							? err.message
							: "Could not apply that decision. Try again.",
				});
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				if (conversationId) {
					queryClient.invalidateQueries({ queryKey: assistantKeys.messages(conversationId) });
					queryClient.invalidateQueries({ queryKey: assistantKeys.approvals(conversationId) });
				}
			}
		},
		[conversationId, queryClient, state.streaming],
	);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		dispatch({ kind: "event", event: { type: "done", messageId: null, usage: null } });
	}, []);

	const startNew = useCallback(() => {
		abortRef.current?.abort();
		setConversationId(null);
		dispatch({ kind: "reset", messages: [] });
	}, []);

	return useMemo(
		() => ({
			conversationId,
			messages: state.messages,
			streaming: state.streaming,
			send,
			decide,
			stop,
			startNew,
			openConversation,
		}),
		[conversationId, state.messages, state.streaming, send, decide, stop, startNew, openConversation],
	);
}
