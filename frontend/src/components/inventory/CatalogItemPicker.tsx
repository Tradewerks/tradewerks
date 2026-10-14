import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useCatalogSearchQuery, useReconcileTargetsQuery } from "../../hooks/useInventory";
import { unitLabel } from "../../lib/units";
import type { ReconcileTarget } from "../../api/inventory";
import { FOCUS_RING, money } from "../reconcile/reconcileFormat";

const PANEL_MAX_HEIGHT = 288; // matches max-h-72 below
const VIEWPORT_MARGIN = 8;

export interface CatalogItemPickerProps {
	value: ReconcileTarget | null;
	onChange: (next: ReconcileTarget | null) => void;
	/** The row being merged away cannot be its own merge target. */
	excludeId?: string;
	placeholder?: string;
	disabled?: boolean;
	id?: string;
	ariaLabel: string;
	/**
	 * Which door to search through. The reconcile queue's route is gated on
	 * `manage_inventory`; a technician mapping a receipt line holds neither that
	 * nor any business with `excludeId`, so they go through `catalog`.
	 */
	scope?: "reconcile" | "catalog";
}

/**
 * Which catalog item a name should point at. Replaces a native select rendering
 * the whole catalog twice per queue row - 2,000 items against a 200-row queue
 * built hundreds of thousands of option nodes and still offered no search, no SKU
 * and no cost. Search runs on the server.
 *
 * Portaled to <body> like SupplierPicker: every caller sits in a panel that clips.
 */
export default function CatalogItemPicker({
	value,
	onChange,
	excludeId,
	placeholder = "Search the catalog…",
	disabled,
	id,
	ariaLabel,
	scope = "reconcile",
}: CatalogItemPickerProps) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [debounced, setDebounced] = useState("");
	const [cursor, setCursor] = useState(0);

	const inputRef = useRef<HTMLInputElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

	// A request per keystroke would refetch mid-word; the list is not that urgent.
	useEffect(() => {
		const t = setTimeout(() => setDebounced(typed.trim()), 200);
		return () => clearTimeout(t);
	}, [typed]);

	// Both hooks are declared because hooks cannot be conditional; only the one
	// this caller is entitled to actually runs.
	const reconcile = useReconcileTargetsQuery(
		{ q: debounced || undefined, excludeId },
		scope === "reconcile"
	);
	const catalog = useCatalogSearchQuery({ q: debounced || undefined }, scope === "catalog");
	const { data, isFetching, error } = scope === "catalog" ? catalog : reconcile;
	const options = useMemo(() => data ?? [], [data]);

	useEffect(() => {
		setCursor(0);
	}, [debounced]);

	const positionPanel = useCallback(() => {
		const rect = inputRef.current?.getBoundingClientRect();
		if (!rect) return;
		// A panel still anchored to an input that has scrolled out of view floats
		// with nothing to explain it, so that is the one case worth dismissing on.
		if (rect.bottom < 0 || rect.top > window.innerHeight) {
			setOpen(false);
			return;
		}
		const spaceBelow = window.innerHeight - rect.bottom;
		const flipUp =
			spaceBelow < PANEL_MAX_HEIGHT + VIEWPORT_MARGIN && rect.top > spaceBelow;
		setPanelStyle(
			flipUp
				? {
						position: "fixed",
						left: rect.left,
						width: rect.width,
						bottom: window.innerHeight - rect.top + 4,
					}
				: {
						position: "fixed",
						left: rect.left,
						width: rect.width,
						top: rect.bottom + 4,
					}
		);
	}, []);

	useLayoutEffect(() => {
		if (!open) {
			setPanelStyle(null);
			return;
		}
		positionPanel();
	}, [open, options.length, positionPanel]);

	// Follows the input instead of dismissing. A capture listener here also sees
	// the panel's own wheel scroll — dismissing on that made the field unusable
	// with a mouse, since the list closed the instant you scrolled it.
	useEffect(() => {
		if (!open) return;
		const onScroll = (e: Event) => {
			// The document's own scroll reports a target that is not a Node.
			const target = e.target;
			if (target instanceof Node && panelRef.current?.contains(target)) return;
			positionPanel();
		};
		const close = () => setOpen(false);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open, positionPanel]);

	function pick(target: ReconcileTarget) {
		onChange(target);
		setTyped("");
		setOpen(false);
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Escape") {
			setOpen(false);
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			setOpen(true);
			setCursor((c) => {
				if (options.length === 0) return 0;
				const next = e.key === "ArrowDown" ? c + 1 : c - 1;
				return (next + options.length) % options.length;
			});
			return;
		}
		if (e.key === "Enter" && open && options[cursor]) {
			e.preventDefault();
			pick(options[cursor]);
		}
	}

	// A chosen item replaces the field entirely: its name, SKU and cost are the
	// answer, and leaving a text input there invites editing something inert.
	if (value) {
		return (
			<div className="flex min-w-0 items-center gap-2 rounded border border-primary-border bg-primary-bg px-2.5 py-2">
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium text-text-primary">
						{value.name}
					</span>
					<span className="block truncate text-[11px] text-text-muted">
						{value.sku ? `${value.sku} · ` : ""}
						{value.cost != null
							? `${money(value.cost)} / ${unitLabel(value.unit)}`
							: "No cost yet"}
						{value.provisional ? " · awaiting detail" : ""}
					</span>
				</span>
				<button
					type="button"
					onClick={() => onChange(null)}
					disabled={disabled}
					aria-label="Clear the selected item"
					className={`flex-shrink-0 cursor-pointer rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary ${FOCUS_RING}`}
				>
					<X aria-hidden size={13} />
				</button>
			</div>
		);
	}

	return (
		<div className="relative min-w-0">
			<Search
				aria-hidden
				size={13}
				className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
			/>
			<input
				ref={inputRef}
				id={id}
				type="text"
				role="combobox"
				aria-expanded={open}
				aria-autocomplete="list"
				aria-label={ariaLabel}
				disabled={disabled}
				value={typed}
				placeholder={placeholder}
				onChange={(e) => {
					setTyped(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => setTimeout(() => setOpen(false), 120)}
				onKeyDown={onKeyDown}
				className={`${
					// Sized off the scope so the dispatch reconcile table stays pixel-identical
					// while the technician line editor matches the 44px controls around it.
					scope === "catalog" ? "h-11" : "h-9"
				} w-full min-w-0 rounded border border-border-input bg-base pl-7 pr-2.5 text-sm text-text-primary transition-colors placeholder:text-text-faint focus:border-primary focus:outline-none disabled:opacity-60`}
			/>
			{open &&
				panelStyle &&
				createPortal(
					<div
						ref={panelRef}
						role="listbox"
						aria-label={ariaLabel}
						style={panelStyle}
						// Dragging the panel's scrollbar blurs the input, and the
						// blur handler closes the list out from under the drag.
						onMouseDown={(e) => e.preventDefault()}
						className="z-50 max-h-72 overflow-y-auto rounded border border-border bg-surface shadow-xl"
					>
						{options.length === 0 ? (
							<p className="px-2.5 py-3 text-xs text-text-muted">
								{/* An empty list and a refused request look identical, and
								    a technician reading "the catalog is empty" would go
								    looking for the wrong problem. */}
								{error
									? "You do not have access to the catalog — ask dispatch to enable it."
									: isFetching
										? "Searching…"
										: debounced
											? `Nothing in the catalog matches "${debounced}".`
											: "The catalog is empty."}
							</p>
						) : (
							options.map((t, i) => (
								<button
									key={t.id}
									type="button"
									role="option"
									aria-selected={i === cursor}
									onMouseDown={(e) =>
										e.preventDefault()
									}
									onMouseEnter={() =>
										setCursor(i)
									}
									onClick={() => pick(t)}
									className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
										i === cursor
											? "bg-primary-bg"
											: "hover:bg-surface-raised"
									}`}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm text-text-primary">
											{t.name}
										</span>
										<span className="block truncate text-[11px] text-text-muted">
											{t.sku ??
												"No SKU"}{" "}
											·{" "}
											{unitLabel(
												t.unit
											)}
											{t.cost !=
											null
												? ` · ${money(t.cost)}`
												: ""}
										</span>
									</span>
									{/* Mapping onto a row that still needs detail is legal and
									    common; it just should not look like a finished item. */}
									{t.provisional && (
										<span className="flex-shrink-0 rounded border border-warning-border bg-warning-bg px-1 py-px text-[9px] font-medium uppercase tracking-wide text-warning-text">
											Detail
										</span>
									)}
								</button>
							))
						)}
					</div>,
					document.body
				)}
		</div>
	);
}
