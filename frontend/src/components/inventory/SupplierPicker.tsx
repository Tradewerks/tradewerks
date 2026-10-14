import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { useSuppliers } from "../../hooks/useSuppliers";
import { normalizeSupplierName } from "../../lib/suppliers";
import type { Supplier, SupplierCapture } from "../../types/suppliers";

const INPUT =
	"border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const PANEL_MAX_HEIGHT = 192; // matches max-h-48 below
const VIEWPORT_MARGIN = 8;

export interface SupplierPickerProps {
	value: SupplierCapture;
	onChange: (value: SupplierCapture) => void;
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
}

/**
 * Who the stock is being bought from, on every intake path.
 *
 * Typing a name that already exists (case- and spacing-insensitive, matching the
 * server's `name_key`) adopts that vendor by id; anything else is submitted as
 * `supplier_name` and created inside the receive transaction. Never required —
 * a blocked receive over missing vendor metadata is worse than an unattributed
 * one — so an empty field emits `{}` and the movement stays unrecorded.
 */
export default function SupplierPicker({
	value,
	onChange,
	label = "Supplier",
	placeholder = "Optional",
	disabled,
	className,
}: SupplierPickerProps) {
	const { data } = useSuppliers();
	const suppliers = useMemo(() => data ?? [], [data]);
	const [dropdownOpen, setDropdownOpen] = useState(false);
	// Only consulted while an id is selected but the list hasn't loaded — the
	// parent's value carries an id, not a name, so there'd be nothing to show.
	const [typed, setTyped] = useState(value.supplier_name ?? "");

	const inputRef = useRef<HTMLInputElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

	// Portaled to <body>, not rendered inline: every caller of this picker
	// (this card included) sits inside a Card, and Card is `overflow-hidden` —
	// the list was getting clipped the moment the input sat anywhere near the
	// bottom of its card, same reason VehicleAllotmentDropdown portals its own
	// panel. Position is computed from the input's own rect, width-matched to
	// it, and flips upward when there isn't room below.
	useLayoutEffect(() => {
		if (!dropdownOpen) {
			setPanelStyle(null);
			return;
		}
		const rect = inputRef.current?.getBoundingClientRect();
		if (!rect) return;
		const spaceBelow = window.innerHeight - rect.bottom;
		const flipUp = spaceBelow < PANEL_MAX_HEIGHT + VIEWPORT_MARGIN && rect.top > spaceBelow;
		setPanelStyle(
			flipUp
				? { position: "fixed", left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 }
				: { position: "fixed", left: rect.left, width: rect.width, top: rect.bottom + 4 },
		);
	}, [dropdownOpen]);

	// Closes rather than repositions on scroll/resize — an autocomplete list
	// this small doesn't need to track the input's rect continuously. The
	// suggestion list scrolls on its own past ~5 vendors, and a capture
	// listener sees that scroll too: unguarded, it closed the list mid-flick.
	useEffect(() => {
		if (!dropdownOpen) return;
		const onScroll = (e: Event) => {
			const target = e.target;
			if (target instanceof Node && panelRef.current?.contains(target)) return;
			setDropdownOpen(false);
		};
		const close = () => setDropdownOpen(false);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [dropdownOpen]);

	const selected: Supplier | undefined = value.supplier_id
		? suppliers.find((s) => s.id === value.supplier_id)
		: undefined;

	const displayText = value.supplier_id ? (selected?.name ?? typed) : (value.supplier_name ?? "");

	const suggestions = useMemo(() => {
		const q = displayText.trim().toLowerCase();
		if (!q) return suppliers;
		return suppliers.filter((s) => s.name.toLowerCase().includes(q));
	}, [suppliers, displayText]);

	const exactMatch = useMemo(() => {
		const key = normalizeSupplierName(displayText);
		if (!key) return undefined;
		return suppliers.find((s) => normalizeSupplierName(s.name) === key);
	}, [suppliers, displayText]);

	const handleTextChange = (text: string) => {
		setTyped(text);
		const key = normalizeSupplierName(text);
		if (!key) {
			onChange({});
			return;
		}
		const exact = suppliers.find((s) => normalizeSupplierName(s.name) === key);
		onChange(exact ? { supplier_id: exact.id } : { supplier_name: text.trim() });
	};

	const handleSelect = (supplier: Supplier) => {
		setTyped(supplier.name);
		onChange({ supplier_id: supplier.id });
		setDropdownOpen(false);
	};

	const isNewName = !!value.supplier_name && !exactMatch;

	return (
		<div className={`relative min-w-0 ${className ?? ""}`}>
			{label && <label className={LABEL}>{label}</label>}
			<input
				ref={inputRef}
				type="text"
				value={displayText}
				onChange={(e) => handleTextChange(e.target.value)}
				onFocus={() => setDropdownOpen(true)}
				onBlur={() => setTimeout(() => setDropdownOpen(false), 120)}
				placeholder={placeholder}
				aria-label={label}
				disabled={disabled}
				className={INPUT}
			/>
			{dropdownOpen &&
				panelStyle &&
				suggestions.length > 0 &&
				createPortal(
					<div
						ref={panelRef}
						style={panelStyle}
						// Dragging the panel's scrollbar blurs the input, and the
						// blur handler closes the list out from under the drag.
						onMouseDown={(e) => e.preventDefault()}
						className="z-[6000] max-h-48 overflow-y-auto rounded border border-border bg-surface shadow-xl"
					>
						{suggestions.map((s) => (
							<button
								key={s.id}
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => handleSelect(s)}
								className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised"
							>
								<span className="truncate">{s.name}</span>
								{s.account_number && (
									<span className="shrink-0 text-xs text-text-muted">
										{s.account_number}
									</span>
								)}
							</button>
						))}
					</div>,
					document.body,
				)}
			{isNewName && (
				<p className="mt-1 flex items-center gap-1 text-xs text-text-muted">
					<Plus size={11} />
					New supplier — will be created on save
				</p>
			)}
		</div>
	);
}
