import { TriangleAlert } from "lucide-react";
import type { UiMessage } from "../../types/assistant";
import ApprovalCard from "./ApprovalCard";
import Markdown from "./Markdown";
import ToolCallCard from "./ToolCallCard";

/**
 * One turn in the thread.
 *
 * Assistant text is markdown (see Markdown.tsx); what the user typed is not —
 * their own message should come back to them exactly as they wrote it.
 */
export default function MessageBubble({
	message,
	onDecide,
	busy = false,
}: {
	message: UiMessage;
	onDecide?: (approvalId: string, decision: "approve" | "reject") => void;
	busy?: boolean;
}) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-on-primary whitespace-pre-wrap break-words">
					{message.content}
				</div>
			</div>
		);
	}

	if (message.role === "error") {
		return (
			<div className="flex items-start gap-2 rounded-lg border border-error-border bg-error-bg px-3 py-2">
				<TriangleAlert size={15} className="mt-0.5 shrink-0 text-error-text" />
				<p className="text-sm text-error-text">{message.content}</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{message.toolCalls.length > 0 && (
				<div className="flex flex-col gap-1">
					{message.toolCalls.map((call) =>
						call.state === "awaiting_approval" && onDecide ? (
							<ApprovalCard key={call.id} call={call} onDecide={onDecide} busy={busy} />
						) : (
							<ToolCallCard key={call.id} call={call} />
						),
					)}
				</div>
			)}

			{message.content && <Markdown>{message.content}</Markdown>}

			{message.streaming && !message.content && message.toolCalls.length === 0 && (
				<div className="flex items-center gap-1.5 text-sm text-text-muted" role="status">
					<span className="sr-only">Thinking</span>
					<Dot delay="0ms" />
					<Dot delay="150ms" />
					<Dot delay="300ms" />
				</div>
			)}
		</div>
	);
}

const Dot = ({ delay }: { delay: string }) => (
	<span
		aria-hidden
		className="inline-block h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse"
		style={{ animationDelay: delay }}
	/>
);
