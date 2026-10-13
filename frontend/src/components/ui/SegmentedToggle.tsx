export interface SegmentedOption<T extends string> {
	id: T;
	label: string;
	// Disabled options stay visible with their tooltip rather than disappearing —
	// a mode unavailable for this item should explain itself.
	disabled?: boolean;
	title?: string;
	/** Row count for this segment, kept separate from the label so the label stays queryable by its own text. */
	badge?: number;
}

interface SegmentedToggleProps<T extends string> {
	value: T;
	options: SegmentedOption<T>[];
	onChange: (id: T) => void;
	ariaLabel: string;
	className?: string;
	/**
	 * Stretch to fill the container at touch-sized height — for a control that IS
	 * the question on screen (e.g. the restock sheet's Restock/Prep switch), not
	 * a lens sitting on a chart.
	 */
	fullWidth?: boolean;
	/**
	 * "boxed" (default): bordered track, for a lens sitting on a chart card.
	 * "flat": no track — only the active segment fills, reading as a filter on
	 * the content below rather than a widget floating above it.
	 */
	variant?: "boxed" | "flat";
	/**
	 * "sm" (default): 28px track for Card headers.
	 * "md": 36px track that sits level with SearchBar / ViewToggle in a page controls row.
	 */
	size?: "sm" | "md";
}

// Shared segmented control so the History tab's range control and the stock
// chart's Units/Value switch read as one control, not near-identical ones.
export default function SegmentedToggle<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	className = "",
	fullWidth = false,
	variant = "boxed",
	size = "sm",
}: SegmentedToggleProps<T>) {
	return (
		<div
			role="group"
			aria-label={ariaLabel}
			className={`${fullWidth ? "flex w-full items-stretch" : "inline-flex"} ${
				variant === "flat"
					? "gap-1"
					: size === "md"
						? "h-9 items-center gap-1 rounded-md border border-border bg-surface p-1"
						: "rounded-md border border-border-subtle bg-surface p-0.5"
			} ${className}`}
		>
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					disabled={o.disabled}
					title={o.title}
					aria-pressed={value === o.id}
					onClick={() => onChange(o.id)}
					// fullWidth targets 40px+ for a gloved thumb; the compact default is
					// fine only under a mouse, and its boxed track comes to 28px so it
					// fits a Card header like any other header action (ui/headerActions).
					className={`${
						fullWidth
							? "flex-1 px-3 py-2 text-sm"
							: size === "md"
								? "inline-flex h-full items-center px-3 text-xs"
								: "inline-flex h-[22px] items-center px-2.5 text-xs"
					} font-medium ${
						variant === "flat" ? "rounded-md" : size === "md" ? "rounded" : "rounded-[5px]"
					} transition-colors ${
						value === o.id
							? "bg-primary-hover text-on-primary"
							: o.disabled
								? "text-text-faint cursor-not-allowed"
								: "text-text-muted hover:text-text-secondary hover:bg-surface cursor-pointer"
					}`}
				>
					{o.label}
					{o.badge != null && o.badge > 0 && (
						<span
							className={`ml-1.5 text-[10px] tabular-nums ${
								value === o.id ? "text-on-primary/70" : "text-text-faint"
							}`}
						>
							{o.badge}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
