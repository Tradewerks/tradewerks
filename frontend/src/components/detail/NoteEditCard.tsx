import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
} from "react";

interface NoteEditCardProps {
	initialContent: string;
	/** Resolves on success (card then calls onClose); throws → card shows error.message, stays open. */
	onSave: (content: string) => Promise<void>;
	/** Cancel, Esc, and after a successful save. */
	onClose: () => void;
	pending: boolean;
	/** Date / (edited) / author line, rendered first. */
	meta?: ReactNode;
	/** Rendered under the textarea. Job passes NotePhotoPicker. */
	attachments?: ReactNode;
	/** Rendered above the action bar. Job passes the visit label. */
	below?: ReactNode;
}

/**
 * A note's card in edit mode, rendered in place of its view card. Same chrome
 * as the view card so the swap doesn't jump. The textarea grows to a cap
 * (max-h-48) so the meta line and action bar still fit the rail at its 416px
 * floor; the action bar is kept in view of the rail's list as the card resizes.
 */
export default function NoteEditCard({
	initialContent,
	onSave,
	onClose,
	pending,
	meta,
	attachments,
	below,
}: NoteEditCardProps) {
	const [content, setContent] = useState(initialContent);
	const [error, setError] = useState<string | null>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const actionsRef = useRef<HTMLDivElement>(null);

	const canSave = !pending && content.trim().length > 0;

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [content]);

	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		}
		const reveal = () => actionsRef.current?.scrollIntoView({ block: "nearest" });
		reveal();
		if (typeof ResizeObserver === "undefined" || !formRef.current) return;
		const observer = new ResizeObserver(reveal);
		observer.observe(formRef.current);
		return () => observer.disconnect();
	}, []);

	const save = async () => {
		if (!canSave) return;
		setError(null);
		try {
			await onSave(content);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save note");
		}
	};

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		void save();
	};

	// On the textarea only: the Job photo-label sheet renders inside this form and
	// its own fields must not cancel or save the whole edit.
	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			e.nativeEvent.stopImmediatePropagation();
			onClose();
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void save();
		}
	};

	return (
		<form
			ref={formRef}
			onSubmit={handleSubmit}
			className="p-3 bg-surface rounded-lg border border-border-strong space-y-3"
		>
			{meta}
			{error && (
				<p
					role="alert"
					className="p-3 bg-error-bg border border-error-border rounded-md text-error-text text-sm"
				>
					{error}
				</p>
			)}
			<textarea
				ref={textareaRef}
				value={content}
				onChange={(e) => setContent(e.target.value)}
				onKeyDown={handleKeyDown}
				aria-label="Edit note text"
				rows={3}
				className="block w-full max-h-48 overflow-y-auto px-3 py-2 bg-base border border-border rounded-md text-text-primary text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
			/>
			{attachments}
			{below}
			<div ref={actionsRef} className="flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					className="px-3 py-1.5 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!canSave}
					className="px-4 py-1.5 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md text-sm font-medium transition-colors"
				>
					{pending ? "Saving..." : "Update Note"}
				</button>
			</div>
		</form>
	);
}
