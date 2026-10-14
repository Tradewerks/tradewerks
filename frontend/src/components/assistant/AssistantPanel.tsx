import { useEffect, useRef, useState } from "react";
import { History, Plus, Sparkles } from "lucide-react";
import Drawer from "../ui/Drawer";
import Composer from "./Composer";
import MessageBubble from "./MessageBubble";
import { useAssistantChat, useAssistantConversations, useAssistantStatus } from "../../hooks/useAssistant";

/**
 * The assistant, in a right-hand drawer alongside the Create panel.
 *
 * Deliberately not a modal: a dispatcher asking "what does Thursday look like"
 * usually wants to act on the answer in the page behind it, so the page stays
 * visible and reachable.
 */
export default function AssistantPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
	const { data: status } = useAssistantStatus();
	const chat = useAssistantChat();
	const [showHistory, setShowHistory] = useState(false);
	const { data: conversations } = useAssistantConversations(isOpen && showHistory);
	const scrollRef = useRef<HTMLDivElement>(null);

	const unavailable = status ? !status.enabled : false;

	// Keep the newest turn in view as it streams.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chat.messages]);

	return (
		<Drawer isOpen={isOpen} onClose={onClose} title="Assistant">
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-2">
					<div className="flex items-center gap-1.5 text-xs text-text-muted">
						<Sparkles size={13} />
						<span>
							{status?.readOnly
								? "Read-only — it can look things up, not change them"
								: "Changes need your approval before they happen"}
						</span>
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => setShowHistory((v) => !v)}
							aria-pressed={showHistory}
							title="Past conversations"
							className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text-primary"
						>
							<History size={15} />
						</button>
						<button
							type="button"
							onClick={() => {
								chat.startNew();
								setShowHistory(false);
							}}
							title="New conversation"
							className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text-primary"
						>
							<Plus size={15} />
						</button>
					</div>
				</div>

				{showHistory && (
					<div className="max-h-48 overflow-y-auto border-b border-border-subtle">
						{conversations?.length ? (
							conversations.map((conversation) => (
								<button
									key={conversation.id}
									type="button"
									onClick={() => {
										void chat.openConversation(conversation.id);
										setShowHistory(false);
									}}
									className={`block w-full truncate px-4 py-2 text-left text-sm hover:bg-surface-raised ${
										conversation.id === chat.conversationId
											? "text-text-primary"
											: "text-text-secondary"
									}`}
								>
									{conversation.title ?? "Untitled"}
								</button>
							))
						) : (
							<p className="px-4 py-3 text-xs text-text-muted">No past conversations yet.</p>
						)}
					</div>
				)}

				<div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
					{unavailable ? (
						<p className="text-sm text-text-muted">{status?.reason}</p>
					) : chat.messages.length === 0 ? (
						<EmptyState onPick={(text) => void chat.send(text)} readOnly={status?.readOnly ?? true} />
					) : (
						chat.messages.map((message) => (
							<MessageBubble
								key={message.id}
								message={message}
								onDecide={(approvalId, decision) => void chat.decide(approvalId, decision)}
								busy={chat.streaming}
							/>
						))
					)}
				</div>

				<div className="border-t border-border-subtle px-4 py-3">
					<Composer
						onSend={(text) => void chat.send(text)}
						onStop={chat.stop}
						streaming={chat.streaming}
						disabled={unavailable}
					/>
				</div>
			</div>
		</Drawer>
	);
}

/**
 * Openers that demonstrate what the tools can actually answer. Generic prompts
 * ("ask me anything") teach nothing; these show the shape of a good question.
 */
const READ_STARTERS = [
	"What's on the schedule this week?",
	"Which visits still need a technician?",
	"Show me quotes waiting on approval",
	"What inventory is running low?",
];

/** Openers that show what the write tools are for, without implying they run unattended. */
const WRITE_STARTERS = [
	"Which visits still need a technician?",
	"Move tomorrow's afternoon visits to Thursday",
	"Draft a quote for a condenser replacement",
	"Log a call from a client as a new request",
];

function EmptyState({ onPick, readOnly }: { onPick: (text: string) => void; readOnly: boolean }) {
	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-text-muted">
				{readOnly
					? "Ask about your organization's jobs, schedule, clients, quotes, invoices, stock or reports."
					: "Ask about your work, or ask for a change — scheduling happens only after you approve it, and new records arrive as drafts for you to review."}
			</p>
			<div className="flex flex-col gap-1.5">
				{(readOnly ? READ_STARTERS : WRITE_STARTERS).map((starter) => (
					<button
						key={starter}
						type="button"
						onClick={() => onPick(starter)}
						className="rounded-md border border-border-subtle bg-surface-inset px-3 py-2 text-left text-sm text-text-secondary hover:border-border-card hover:text-text-primary"
					>
						{starter}
					</button>
				))}
			</div>
		</div>
	);
}
