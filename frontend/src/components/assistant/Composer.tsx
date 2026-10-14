import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

/**
 * The input. Enter sends, Shift+Enter breaks a line — the convention people
 * already expect from every other chat box, so it needs no explaining.
 */
export default function Composer({
	onSend,
	onStop,
	streaming,
	disabled,
}: {
	onSend: (text: string) => void;
	onStop: () => void;
	streaming: boolean;
	disabled?: boolean;
}) {
	const [value, setValue] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);

	// Grow with the content up to a ceiling, then scroll inside.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [value]);

	const submit = () => {
		const text = value.trim();
		if (!text || streaming || disabled) return;
		onSend(text);
		setValue("");
	};

	return (
		<div className="flex items-end gap-2 rounded-lg border border-input bg-surface-inset px-2.5 py-2 focus-within:ring-1 focus-within:ring-primary-border">
			<textarea
				ref={ref}
				rows={1}
				value={value}
				disabled={disabled}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
				placeholder={disabled ? "Assistant unavailable" : "Ask about jobs, schedules, clients…"}
				aria-label="Message the assistant"
				className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
			/>

			{streaming ? (
				<button
					type="button"
					onClick={onStop}
					aria-label="Stop generating"
					title="Stop"
					className="shrink-0 rounded-md bg-surface-raised p-1.5 text-text-secondary hover:text-text-primary"
				>
					<Square size={14} />
				</button>
			) : (
				<button
					type="button"
					onClick={submit}
					disabled={!value.trim() || disabled}
					aria-label="Send"
					title="Send"
					className="shrink-0 rounded-md bg-primary p-1.5 text-on-primary hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
				>
					<ArrowUp size={14} />
				</button>
			)}
		</div>
	);
}
