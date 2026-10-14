import { useId } from "react";

interface ReasonFieldProps {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	label?: string;
	rows?: number;
}

/**
 * Extracted from DisputeModal's open-mode body so opening a dispute, rejecting
 * a quote, and cancelling a quote all read as one family of "capture a reason"
 * actions rather than three independently-styled textareas.
 */
export default function ReasonField({
	value,
	onChange,
	placeholder,
	label = "Reason",
	rows = 4,
}: ReasonFieldProps) {
	// The label sits above the textarea rather than wrapping it, so without an
	// explicit association a screen reader reads an unlabeled field and falls
	// back to the placeholder — which is not an accessible name.
	const fieldId = useId();
	return (
		<div>
			<label
				htmlFor={fieldId}
				className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2"
			>
				{label}
			</label>
			<textarea
				id={fieldId}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				rows={rows}
				className="w-full px-3 py-2.5 bg-surface-inset border border-border rounded-md text-sm text-primary placeholder:text-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary-border transition-colors duration-150 ease-out resize-none"
			/>
		</div>
	);
}
