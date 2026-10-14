// Shared role="switch" on/off toggle
export default function ToggleSwitch({
	checked,
	onChange,
	disabled,
	label,
	ariaLabel,
	ariaDescribedBy,
}: {
	checked: boolean;
	onChange: () => void;
	disabled?: boolean;
	label?: string;
	ariaLabel?: string;
	ariaDescribedBy?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel ?? label}
			aria-describedby={ariaDescribedBy}
			onClick={onChange}
			disabled={disabled}
			className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed hover:cursor-pointer ${
				checked ? "bg-primary-hover" : "bg-border-strong"
			}`}
		>
			<span
				className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
					checked ? "translate-x-4.5" : "translate-x-0.5"
				}`}
			/>
		</button>
	);
}
