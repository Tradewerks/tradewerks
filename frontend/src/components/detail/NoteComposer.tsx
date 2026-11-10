import { useState, type FormEvent, type ReactNode } from "react";

interface NoteComposerProps {
	/** Resolves on success; throws on failure (composer shows error.message, keeps text). */
	onSubmit: (content: string) => Promise<void>;
	canWrite: boolean;
	pending: boolean;
	/** Disables the form without a permission reason, e.g. while notes load. */
	disabled?: boolean;
	/** Rendered between textarea and submit. Job/Visit pass NotePhotoPicker. */
	attachments?: ReactNode;
}

const NO_PERMISSION = "You don't have permission to perform this action";

export default function NoteComposer({
	onSubmit,
	canWrite,
	pending,
	disabled = false,
	attachments,
}: NoteComposerProps) {
	const [content, setContent] = useState("");
	const [error, setError] = useState<string | null>(null);

	const locked = !canWrite || disabled;
	const title = !canWrite ? NO_PERMISSION : undefined;

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		if (locked || pending || !content.trim()) return;
		setError(null);
		try {
			await onSubmit(content);
			setContent("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save note");
		}
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			{error && (
				<p
					role="alert"
					className="p-3 bg-error-bg border border-error-border rounded-md text-error-text text-sm"
				>
					{error}
				</p>
			)}
			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Leave context for whoever picks this up next…"
				aria-label="New note"
				rows={3}
				disabled={locked || pending}
				title={title}
				className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
			/>
			{attachments}
			<button
				type="submit"
				disabled={locked || pending || !content.trim()}
				title={title}
				className="w-full px-4 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md text-sm font-medium transition-colors"
			>
				{pending ? "Saving..." : "Add Note"}
			</button>
		</form>
	);
}
