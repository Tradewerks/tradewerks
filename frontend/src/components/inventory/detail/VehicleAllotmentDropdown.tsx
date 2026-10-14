import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ChevronDown, Truck, type LucideIcon } from "lucide-react";
import { useItemVehicleStockQuery } from "../../../hooks/useTracking";
import { unitLabel } from "../../../lib/units";

// Panel width matches `w-64` below; height is a worst-case estimate (its
// content is capped at `max-h-64` regardless of row count) used ONLY to
// decide drop-down vs flip-up — not to render, so there's no measure-then-
// place layout jump.
const PANEL_WIDTH = 256;
const PANEL_HEIGHT_ESTIMATE = 280;
const VIEWPORT_MARGIN = 8;

// The "on vehicles" tile's answer to "which vehicle, how much" — the
// aggregate number alone can't say that. The panel portals to <body> and
// positions itself from the trigger's own bounding rect: StockPlacementCard
// renders this inside Card, and Card is `overflow-hidden` (so its rounded
// corners clip square children) — an absolutely-positioned child of THAT
// gets clipped the moment its trigger sits anywhere near the card's bottom
// edge, which is every current call site. Portaling to <body> sidesteps that
// ancestor entirely instead of loosening Card's overflow for every card in
// the app.
export default function VehicleAllotmentDropdown({
	itemId,
	icon: Icon = Truck,
	label,
	value,
	unit,
}: {
	itemId: string;
	icon?: LucideIcon;
	label: string;
	value: number;
	/** Item's unit code, for the per-vehicle quantity suffix. */
	unit: string;
}) {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	// Fetch only once actually opened — the card mounts on every item-detail
	// load, and most opens never expand this tile.
	const { data, isLoading, isError, refetch } = useItemVehicleStockQuery(itemId, open);
	const rows = data?.rows ?? [];

	// Placement, computed once per open from the trigger's rect. Right-edge
	// aligned to the trigger either way, clamped inside the viewport.
	useLayoutEffect(() => {
		if (!open) {
			setPanelStyle(null);
			return;
		}
		const rect = triggerRef.current?.getBoundingClientRect();
		if (!rect) return;

		const left = Math.min(
			Math.max(rect.right - PANEL_WIDTH, VIEWPORT_MARGIN),
			window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN,
		);
		const spaceBelow = window.innerHeight - rect.bottom;
		const flipUp = spaceBelow < PANEL_HEIGHT_ESTIMATE + VIEWPORT_MARGIN && rect.top > spaceBelow;

		setPanelStyle(
			flipUp
				? { position: "fixed", left, bottom: window.innerHeight - rect.top + VIEWPORT_MARGIN }
				: { position: "fixed", left, top: rect.bottom + VIEWPORT_MARGIN },
		);
	}, [open]);

	// Outside-click + Escape. The panel is portaled outside the trigger's DOM
	// subtree, so a click inside it would otherwise register as "outside" —
	// both refs have to clear before this closes.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target)) return;
			if (panelRef.current?.contains(target)) return;
			setOpen(false);
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

	// Close rather than reposition on scroll/resize — a drill-in this small
	// doesn't need to track the trigger's rect continuously. Its own vehicle
	// list scrolls though, and a capture listener sees that too: unguarded,
	// scrolling down to the vehicle you wanted closed the panel.
	useEffect(() => {
		if (!open) return;
		const onScroll = (e: Event) => {
			const target = e.target;
			if (target instanceof Node && panelRef.current?.contains(target)) return;
			setOpen(false);
		};
		const close = () => setOpen(false);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	const tileClasses = "flex-1 min-w-[140px] rounded-lg px-4 py-3 text-left";

	if (value <= 0) {
		// Nothing to drill into — same tile shape, no button/chevron.
		return (
			<div className={`${tileClasses} border border-border-subtle bg-base`}>
				<div className="flex items-center gap-1.5 text-text-muted">
					<Icon size={13} />
					<span className="text-[10px] font-semibold uppercase tracking-wider">
						{label}
					</span>
				</div>
				<div className="mt-1 text-xl font-bold tabular-nums leading-tight text-text-primary">
					{value}
				</div>
			</div>
		);
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${label}: ${value} ${unitLabel(unit, value)}. View per-vehicle breakdown`}
				className={`${tileClasses} relative border pr-9 transition-colors ${
					open
						? "border-primary/40 bg-surface-raised/60"
						: "border-border-subtle bg-base hover:border-border-strong hover:bg-surface-raised/40"
				}`}
			>
				<div className="flex items-center gap-1.5 text-text-muted">
					<Icon size={13} className="shrink-0" />
					<span className="text-[10px] font-semibold uppercase tracking-wider">
						{label}
					</span>
				</div>
				<div className="mt-1 text-xl font-bold tabular-nums leading-tight text-text-primary">
					{value}
					<span className="ml-1 text-xs font-normal text-text-faint">
						{unitLabel(unit, value)}
					</span>
				</div>

				{/* Boxed, vertically centered on the tile's right edge — the previous
				    inline chevron sat next to the label alone and read as decoration
				    more than a control. */}
				<span
					className={`absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border transition-colors ${
						open
							? "border-primary/50 bg-primary-bg text-primary-text"
							: "border-border-strong bg-surface-raised text-text-secondary"
					}`}
				>
					<ChevronDown
						size={13}
						className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
					/>
				</span>
			</button>

			{open &&
				panelStyle &&
				createPortal(
					<div
						ref={panelRef}
						role="listbox"
						aria-label={`${label} by vehicle`}
						style={panelStyle}
						className="z-50 w-64 overflow-hidden rounded-lg border border-border-strong bg-canvas shadow-2xl shadow-black/50"
					>
						{isLoading ? (
							<div className="space-y-1.5 p-3">
								<div className="h-4 animate-pulse rounded bg-surface-raised" />
								<div className="h-4 animate-pulse rounded bg-surface-raised" />
							</div>
						) : isError ? (
							<div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
								<AlertCircle size={16} className="text-error-text/60" />
								<p className="text-xs text-error-text">
									Couldn't load vehicle breakdown.
								</p>
								<button
									type="button"
									onClick={() => refetch()}
									className="text-xs font-medium text-primary hover:text-primary-text"
								>
									Try again
								</button>
							</div>
						) : rows.length === 0 ? (
							<div className="px-3 py-2.5 text-xs text-text-faint">
								No vehicle currently holds this item.
							</div>
						) : (
							<div className="max-h-64 divide-y divide-border-subtle/40 overflow-y-auto py-1">
								{rows.map((r) => (
									<div
										key={r.vehicle_id}
										role="option"
										aria-selected={false}
										tabIndex={0}
										onClick={() => {
											setOpen(false);
											navigate(`/dispatch/vehicles/${r.vehicle_id}/stock`);
										}}
										onKeyDown={(e) => {
											if (e.key !== "Enter" && e.key !== " ") return;
											e.preventDefault();
											setOpen(false);
											navigate(`/dispatch/vehicles/${r.vehicle_id}/stock`);
										}}
										className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-surface-raised/60 focus-visible:outline-none focus-visible:bg-surface-raised/60"
									>
										<div className="min-w-0">
											<div className="truncate text-sm font-medium text-text-primary">
												{r.vehicle_name}
											</div>
											{(r.technician_name ||
												r.vehicle_status !== "active") && (
												<div className="truncate text-[11px] text-text-faint">
													{r.technician_name ??
														"Unassigned"}
													{r.vehicle_status !==
														"active" &&
														` · ${r.vehicle_status}`}
												</div>
											)}
										</div>
										<span className="shrink-0 text-sm font-semibold tabular-nums text-text-primary">
											{r.qty_on_hand}
											<span className="ml-1 text-[11px] font-normal text-text-faint">
												{unitLabel(
													unit,
													r.qty_on_hand,
												)}
											</span>
										</span>
									</div>
								))}
							</div>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}
