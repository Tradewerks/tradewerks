import { useState } from "react";
import { inputClass } from "./AuthCard";
import { smallButton } from "./orgDetailUi";

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
				className={`${smallButton} h-9!`}
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
