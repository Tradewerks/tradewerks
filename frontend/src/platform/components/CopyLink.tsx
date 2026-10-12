import { useState } from "react";
import { inputClass } from "./AuthCard";

export default function CopyLink({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex gap-2">
			<input
				readOnly
				value={url}
				aria-label="Invite link"
				className={`${inputClass} min-w-0`}
			/>
			<button
				type="button"
				className="h-9 shrink-0 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-inset"
				onClick={() => {
					void navigator.clipboard.writeText(url);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? "Copied" : "Copy link"}
			</button>
		</div>
	);
}
