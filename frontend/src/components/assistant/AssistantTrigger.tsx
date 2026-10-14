import { Sparkles } from "lucide-react";
import { useAssistantStatus } from "../../hooks/useAssistant";

/**
 * Header entry point.
 *
 * Renders nothing when the assistant is unavailable — either the server has no
 * key configured, or this user's permissions reach none of its tools. A button
 * that can only apologise is worse than no button.
 */
export default function AssistantTrigger({ onClick }: { onClick: () => void }) {
	const { data: status } = useAssistantStatus();
	if (!status?.enabled) return null;

	return (
		<button
			type="button"
			onClick={onClick}
			title="Assistant"
			aria-label="Open the assistant"
			className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-text-tertiary hover:bg-surface-raised hover:text-text-primary"
		>
			<Sparkles size={18} />
			<span className="hidden text-sm font-medium sm:inline">Ask</span>
		</button>
	);
}
