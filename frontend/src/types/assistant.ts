/** Shapes shared by the assistant API client, hook and components. */

export interface AssistantStatus {
	enabled: boolean;
	/** Why it is off, in words worth showing a person. Null when enabled. */
	reason: string | null;
	model: string | null;
	readOnly: boolean;
	toolCount: number;
	tools: { name: string; title: string }[];
}

export interface AssistantConversation {
	id: string;
	title: string | null;
	created_at: string;
	updated_at: string;
}

export interface StoredToolCall {
	id: string;
	provider_call_id: string;
	tool_name: string;
	input: unknown;
	status: string;
	result: unknown;
	error_code: string | null;
	duration_ms: number | null;
}

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	created_at: string;
	input_tokens: number | null;
	output_tokens: number | null;
	tool_calls: StoredToolCall[];
}

/** Mirrors backend/src/assistant/events.ts. Keep the two in step. */
export type AssistantEvent =
	| { type: "conversation"; id: string; title: string | null }
	| { type: "text_delta"; text: string }
	| { type: "tool_call"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			id: string;
			ok: boolean;
			summary: string;
			errorCode?: string;
			errorMessage?: string;
			durationMs: number;
	  }
	| {
			type: "approval_required";
			/** What POST /assistant/approvals/:id takes. */
			approvalId: string;
			/** The provider's call id, matching the tool card already on screen. */
			id: string;
			name: string;
			title: string;
			summary: string;
			input: unknown;
	  }
	| { type: "approval_resolved"; approvalId: string; id: string; approved: boolean }
	| { type: "invalidate"; keys: string[] }
	| { type: "done"; messageId: string | null; usage: { input: number; output: number } | null }
	| { type: "error"; message: string; code?: string };

/** A pending action, as the panel renders it and as GET .../approvals returns it. */
export interface PendingApproval {
	approvalId: string;
	id: string;
	name: string;
	title: string;
	summary: string;
	input: unknown;
}

/** A tool call as the panel renders it — running, awaiting a decision, then resolved. */
export interface UiToolCall {
	id: string;
	name: string;
	input: unknown;
	state: "running" | "ok" | "error" | "awaiting_approval" | "declined";
	summary?: string;
	errorMessage?: string;
	durationMs?: number;
	/** Present while a human decision is outstanding. */
	approvalId?: string;
	title?: string;
}

export type UiMessage =
	| { id: string; role: "user"; content: string }
	| {
			id: string;
			role: "assistant";
			content: string;
			toolCalls: UiToolCall[];
			/** True while this message is still being streamed. */
			streaming: boolean;
	  }
	| { id: string; role: "error"; content: string };
