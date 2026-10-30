import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import { DIMENSION_LABELS } from "./usePageReport";

interface BreakdownPickerProps {
	value: string;
	options: string[];
	onChange: (value: string) => void;
}

// A required one-of grouping, not a filter: no "All", no clear, never "active"-blue.
// Trigger and menu match DateRangeFilter so the popover's two controls read as a pair.
export default function BreakdownPicker({ value, options, onChange }: BreakdownPickerProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const label = (dim: string) => DIMENSION_LABELS[dim] ?? dim;

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`Break down by ${label(value)}`}
				className="flex h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-base px-3 text-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				<Layers size={14} className="shrink-0" />
				<span>
					By <span className="text-text-primary">{label(value)}</span>
				</span>
				<ChevronDown size={14} className="shrink-0" />
			</button>
			{open && (
				<div
					role="listbox"
					aria-label="Break down by"
					className="absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-lg border border-border-strong bg-canvas shadow-2xl shadow-black/50"
				>
					<div className="px-1 py-1">
						{options.map((dim) => {
							const selected = dim === value;
							return (
								<button
									type="button"
									key={dim}
									role="option"
									aria-selected={selected}
									onClick={() => {
										onChange(dim);
										setOpen(false);
									}}
									className={`flex w-full cursor-pointer items-center justify-between rounded px-3 py-1.5 text-left text-sm ${
										selected
											? "bg-primary-bg text-primary-text"
											: "text-text-secondary hover:bg-surface/70"
									}`}
								>
									<span>{label(dim)}</span>
									{selected && <Check size={14} />}
								</button>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
