import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check, X } from "lucide-react";
import { useMultiSearch } from "../../hooks/useMultiSearch";

export interface StatusOption {
	value: string;
	label: string;
}

interface BaseProps {
	options: StatusOption[];
	allLabel?: string;
	placeholder?: string;
	hideAll?: boolean;
}

interface StatusFilterUrlProps extends BaseProps {
	paramKey: string;
}

interface StatusFilterControlledProps extends BaseProps {
	values: string[] | null;
	onChange: (value: string | null) => void;
	exclusive?: boolean;
}

type StatusFilterProps = StatusFilterUrlProps | StatusFilterControlledProps;

export default function StatusFilter(props: StatusFilterProps) {
	if ("paramKey" in props) {
		return <UrlStatusFilter {...props} />;
	}
	return <DropdownFilter {...props} />;
}

function UrlStatusFilter({ paramKey, ...rest }: StatusFilterUrlProps) {
	const { terms, addTerm, removeTerm, clearAll } = useMultiSearch(paramKey, { splitCommas: true });

	const handleChange = (newValue: string | null) => {
		if (!newValue) {
			clearAll();
			return;
		}
		if (terms.includes(newValue)) removeTerm(newValue);
		else addTerm(newValue);
	};

	return <DropdownFilter values={terms} onChange={handleChange} {...rest} />;
}

export function DropdownFilter({
	values,
	onChange,
	options,
	allLabel = "All",
	placeholder = "Status",
	hideAll = false,
	exclusive = false,
}: StatusFilterControlledProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const selectedOptions = options.filter((o) => values?.includes(o.value) ?? false);
	const isActive = selectedOptions.length > 0;

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
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

	const handleSelect = (optionValue: string | null) => {
		if (optionValue === null) {
			onChange(null); // selects "All"
			if (exclusive) setOpen(false);
			return;
		}
		const alreadySelected = selectedOptions.some((o) => o.value === optionValue);
		// if all select clears selection (multi-select only — exclusive callers pick one at a time)
		if (!exclusive && !alreadySelected && selectedOptions.length + 1 >= options.length) {
			onChange(null);
			return;
		}
		onChange(optionValue);
		// Exclusive (one-of) callers are done after a single pick; multi-select stays open.
		if (exclusive) setOpen(false);
	};

	const triggerLabel = !isActive
		? placeholder
		: selectedOptions.length === 1
			? `${placeholder}: ${selectedOptions[0].label}`
			: `${placeholder} (${selectedOptions.length})`;

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-haspopup="listbox"
				className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm transition-colors cursor-pointer whitespace-nowrap ${
					isActive && !hideAll
						? "bg-primary-bg border-primary text-primary-text pr-7"
						: "bg-base border-border text-text-tertiary hover:text-text-primary"
				}`}
			>
				<span>{triggerLabel}</span>
				{!(isActive && !hideAll) && (
					<ChevronDown size={14} className="shrink-0" />
				)}
			</button>
			{isActive && !hideAll && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onChange(null); }}
					aria-label="Clear filter"
					className="absolute right-2 top-1/2 -translate-y-1/2 text-primary-text/70 hover:text-primary-text"
				>
					<X size={14} className="shrink-0" />
				</button>
			)}

			{open && (
				<div
					role="listbox"
					aria-label={placeholder}
					className="absolute right-0 mt-1.5 min-w-44 bg-canvas border border-border-strong rounded-lg shadow-2xl shadow-black/50 z-50 overflow-hidden"
				>
					<div className="py-1 px-1">
						{!hideAll && (
							<>
								<button
									role="option"
									aria-selected={!isActive}
									onClick={() => handleSelect(null)}
									className={`w-full flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer rounded text-left ${
										!isActive
											? "bg-primary-bg text-primary-text"
											: "text-text-secondary hover:bg-surface/70"
									}`}
								>
									<span>{allLabel}</span>
									{!isActive && <Check size={14} />}
								</button>
								<div className="border-t border-border my-1 -mx-1" />
							</>
						)}
						{options.map((option) => (
							<button
								key={option.value}
								role="option"
								aria-selected={selectedOptions?.includes(option)}
								onClick={() => handleSelect(option.value)}
								className={`w-full flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer rounded text-left ${
									selectedOptions?.includes(option)
										? "bg-primary-bg text-primary-text"
										: "text-text-secondary hover:bg-surface/70"
								}`}
							>
								<span>{option.label}</span>
								{selectedOptions?.includes(option) && <Check size={14} />}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
