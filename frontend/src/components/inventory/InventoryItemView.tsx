import { Fragment, useState, useRef, useEffect, type ReactNode } from "react";
import { SquarePen, Trash2, MoreHorizontal, Link2 } from "lucide-react";
import type { InventoryItem, InventoryTag } from "../../types/inventory";
import {
	calculateStockStatus,
	getStatusLabel,
	getStatusBadgeClass,
	getStockRingColor,
	formatter,
} from "../../util/util";
import { formatQty } from "../../lib/units";
import ImageCarousel from "./ImageCarousel";
import AddToLabelQueueButton from "./labels/AddToLabelQueueButton";
import { TrackingBadges } from "./TrackingBadges";
import LocationValue, { UNASSIGNED_LOCATION } from "./LocationValue";

interface InventoryItemViewProps {
	item: InventoryItem;
	/** Opens the full edit-item form. */
	onEditItem?: () => void;
	onClick?: () => void;
	viewMode?: "card" | "list";
	onDelete?: () => void;
	isHighlighted?: boolean;
	onHighlightMouseLeave?: () => void;
	qbConnected?: boolean;
	isLinkedToQB?: boolean;
  	onLinkQB?: () => void;
}

// Characters that fit inside the 32px stock ring at 11px bold.
const RING_CHARS = 4;

/**
 * Quantity as it fits in the ring: thousands compact the same way the alert
 * threshold does ("1.2K"); below that, decimals are trimmed only as far as
 * needed ("12.5", "123.75" → "124", "0.42"). The exact value is in the ring's
 * title/aria-label, so nothing is lost — only the tiny label is abbreviated.
 */
function ringQty(quantity: number): string {
	if (Math.abs(quantity) >= 1000) return formatter.format(quantity);
	for (const maximumFractionDigits of [2, 1, 0]) {
		const s = quantity.toLocaleString(undefined, { maximumFractionDigits });
		if (s.length <= RING_CHARS) return s;
	}
	return String(Math.round(quantity));
}

// Max rows of tag chips a list row absorbs before clipping.
const TAG_ROWS = 2;

type MetaPill = { label: string; value: string; truncate: boolean; muted?: boolean };

/**
 * Tag chips clipped to two rows, with overflow counted in a trailing "+N".
 * Chip count is measured rather than fixed, since how many fit varies with
 * row width. Clipped chips stay in the DOM for screen readers.
 */
function TagChipRow({ tags }: { tags: InventoryTag[] }) {
	const chipsRef = useRef<HTMLDivElement>(null);
	const [clipHeight, setClipHeight] = useState<number | null>(null);
	const [hiddenCount, setHiddenCount] = useState(0);

	useEffect(() => {
		const el = chipsRef.current;
		if (!el) return;
		const measure = () => {
			const chips = Array.from(el.children) as HTMLElement[];
			// No layout yet (first paint, jsdom): keep the CSS fallback clip instead of collapsing to 0.
			if (chips.length === 0 || !chips[0].offsetHeight) return;
			// Rows are read off actual layout, not a hardcoded chip height: one row is one distinct offsetTop.
			const tops: number[] = [];
			for (const chip of chips) {
				if (!tops.includes(chip.offsetTop)) tops.push(chip.offsetTop);
			}
			const visibleTops = tops.slice(0, TAG_ROWS);
			const lastVisibleTop = visibleTops[visibleTops.length - 1];
			setClipHeight(lastVisibleTop - tops[0] + chips[0].offsetHeight);
			setHiddenCount(chips.filter((c) => !visibleTops.includes(c.offsetTop)).length);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [tags]);

	return (
		<div className="flex items-center gap-1.5 shrink-0 max-w-[42%]">
			{/* Fallback max-h covers the frame before first measurement, so a tag-heavy item doesn't flash three rows. */}
			<div
				ref={chipsRef}
				className="flex flex-wrap content-start justify-end gap-1 min-w-0 overflow-hidden max-h-[2.75rem]"
				style={clipHeight != null ? { maxHeight: clipHeight } : undefined}
			>
				{tags.map((tag) => (
					<span
						key={tag.id}
						title={tag.label}
						className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-surface border border-border-subtle text-text-secondary max-w-full truncate"
					>
						{tag.label}
					</span>
				))}
			</div>
			{/* Sibling of the clipped block, so it centers against one row or two either way. */}
			{hiddenCount > 0 && (
				<span
					className="text-[10px] text-text-muted shrink-0 self-center"
					title={tags
						.slice(tags.length - hiddenCount)
						.map((t) => t.label)
						.join(", ")}
				>
					+{hiddenCount}
				</span>
			)}
		</div>
	);
}

function FieldRow({ label, value, colSpan }: { label: string; value: ReactNode; colSpan?: boolean }) {
	return (
		// min-w-0 + break-words: a spaceless long value otherwise sets the grid track's
		// min-content width and overflows the card. Clamped to 2 lines; full text stays in title.
		<div className={`min-w-0 ${colSpan ? "col-span-2" : ""}`}>
			<h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider border-b border-border-subtle pb-0.5">{label}</h2>
			<p
				className="text-text-secondary text-sm mt-0.5 break-words line-clamp-2"
				title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}
			>
				{value}
			</p>
		</div>
	);
}

export default function InventoryItemView({
	item,
	onEditItem,
	onClick,
	viewMode = "card",
	onDelete,
	isHighlighted = false,
	onHighlightMouseLeave,
	qbConnected,
	isLinkedToQB,
	onLinkQB
}: InventoryItemViewProps) {
	const stockStatus = item.stock_status ?? calculateStockStatus(item.quantity, item.low_stock_threshold);
	const threshold = item.low_stock_threshold;

	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [menuOpen]);

	// Kebab would be empty once Settings/Delete move inline on wide rows — keep it only
	// when QuickBooks has content only it can show.
	const hasQbMenuContent = !!qbConnected && (!!isLinkedToQB || !!onLinkQB);

	if (viewMode === "list") {
		const ringColor = getStockRingColor(stockStatus);
		const CIRC = 81.68; // 2π × r(13)
		const fillRatio =
			stockStatus === "out_of_stock" || stockStatus === "sufficient"
				? 1
				: stockStatus === "low" && threshold !== null
				? Math.min(item.quantity / threshold, 1)
				: 1;
		const dashOffset = CIRC * (1 - fillRatio);

		// PRICE never shrinks and stays last; SKU/location truncate instead so a long
		// freetext value can't push it out of the clipped row.
		// LOC is unconditional (unlike SKU/PRICE): an unassigned item still shows the
		// pill, muted, rather than disappearing — the list view must surface the same
		// "Unassigned" state the card view does, not silently drop the cell.
		const metaPills = [
			item.sku ? { label: "SKU", value: item.sku, truncate: true } : null,
			{
				label: "LOC",
				value: item.location ?? UNASSIGNED_LOCATION,
				truncate: true,
				muted: item.location == null,
			},
			item.unit_price !== null
				? { label: "PRICE", value: `$${Number(item.unit_price).toFixed(2)}`, truncate: false }
				: null,
		].filter((p): p is MetaPill => p !== null);

		const tags = item.tags ?? [];

		return (
			<div
				className={`flex items-center gap-3 w-full bg-base rounded-lg border border-border-subtle hover:bg-surface hover:border-border-strong transition-colors duration-150 cursor-pointer px-3.5 py-1.5 group ${
					isHighlighted ? "highlight-active" : ""
				}`}
				onClick={onClick}
				onMouseLeave={() => isHighlighted && onHighlightMouseLeave?.()}
			>
				{/* Thumbnail — 36×36 */}
				<div className="w-[36px] h-[36px] shrink-0 rounded-md overflow-hidden">
					<ImageCarousel
						images={item.image_urls ?? []}
						compact
						compactNav
						className="!h-[36px]"
					/>
				</div>

				{/* Content zone: left = name/badges/location+price, right = tags */}
				<div className="flex-1 min-w-0 flex items-center gap-3">
					{/* Left: name/badges (clamped to 2 lines) + meta pills — caps how far one long name can grow the row. */}
					<div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
						<div className="flex items-start gap-2 min-w-0">
							<span
								className="text-[13px] font-semibold text-text-primary line-clamp-2 break-words min-w-0"
								title={item.name}
							>
								{item.name}
							</span>
							{/* Wrapped so the badges keep their own row alignment
							    against a name that now may be two lines tall. */}
							<span className="flex items-center gap-2 shrink-0 mt-px">
								<TrackingBadges item={item} />
							</span>
						</div>
						{metaPills.length > 0 && (
							<div className="flex items-center gap-2 min-w-0 overflow-hidden">
								{metaPills.map((pill, i) => (
									<Fragment key={`${pill.label}-${i}`}>
										{i > 0 && (
											<span className="text-text-muted text-[10px] shrink-0">·</span>
										)}
										{/* No flex here: a flex box turns its text into an anonymous item that clips without ellipsis. */}
										<span
											className={`text-[11px] ${pill.muted ? "text-text-muted" : "text-text-secondary"} ${
												pill.truncate
													? "min-w-0 truncate"
													: "shrink-0 whitespace-nowrap"
											}`}
											title={pill.truncate ? pill.value : undefined}
										>
											<span className="text-[10px] text-text-muted uppercase tracking-wide mr-0.5">{pill.label}</span>
											{pill.value}
										</span>
									</Fragment>
								))}
							</div>
						)}
					</div>

					{/* Right: tags — a right-aligned two-column block, vertically
					    centered against the left block whatever height either takes */}
					{tags.length > 0 && <TagChipRow tags={tags} />}
				</div>

				{/* Right panel */}
				<div
					className="flex items-center shrink-0"
					onClick={(e) => e.stopPropagation()}
				>
					{/* Divider */}
					<div className="w-px self-stretch bg-border-subtle mr-1.5 shrink-0" />

					{/* QTY label */}
					<div className="flex flex-col items-center leading-none text-[8px] font-bold text-text-muted tracking-tight shrink-0 gap-[3px] mr-2.5">
						<span>Q</span>
						<span>T</span>
						<span>Y</span>
					</div>

					{/* Stock ring — 32×32; unit has no room here, so it lives in the accessible name instead. */}
					<div
						className="relative w-[32px] h-[32px] shrink-0 mr-2"
						role="img"
						title={formatQty(item.quantity, item.unit)}
						aria-label={`${formatQty(item.quantity, item.unit)} in warehouse`}
					>
						<svg width="32" height="32" viewBox="0 0 32 32">
							<circle cx="16" cy="16" r="13" fill="none" stroke="#27272a" strokeWidth="3" />
							<circle
								cx="16" cy="16" r="13" fill="none"
								stroke={ringColor}
								strokeWidth="3"
								strokeDasharray={CIRC}
								strokeDashoffset={dashOffset}
								strokeLinecap="round"
								transform="rotate(-90 16 16)"
							/>
						</svg>
						{/* Fitted to the ring (≈4 characters at this size): a raw
						    1234.75 overflowed it. The exact figure stays in the
						    title/aria-label above. */}
						<div className="absolute inset-0 flex items-center justify-center">
							<span className="text-[11px] font-bold text-text-primary leading-none">
								{ringQty(item.quantity)}
							</span>
						</div>
					</div>

					{/* Status badge — fixed width so divider aligns across all rows */}
					<div className="w-[82px] flex justify-center shrink-0 mr-1.5">
						{stockStatus !== null && (
							<span
								className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${getStatusBadgeClass(stockStatus)}`}
							>
								<span className="w-1.5 h-1.5 rounded-full bg-current" />
								{getStatusLabel(stockStatus)}
							</span>
						)}
					</div>

					{/* Divider */}
					<div className="w-px self-stretch bg-border-subtle mr-2 shrink-0" />

					{/* Action cluster — label queue sits directly left of the
					    settings/delete pair so all three read as one group. */}
					<div className="flex items-center gap-1.5 mr-1.5">
						<AddToLabelQueueButton
							item={item}
							title="Add to label queue"
							className="w-[28px] h-[28px] rounded-md border border-border flex items-center justify-center text-text-muted hover:bg-surface hover:text-text-primary transition-colors"
						>
							<span className="sr-only">Add to Label Queue</span>
						</AddToLabelQueueButton>

						{/* Wide rows show these inline, narrow ones fold into the kebab. Gated on container
						    width (@container/list), not scrollWidth — these buttons are what would cause
						    the overflow such a check tests for. */}
						<div className="hidden @min-[880px]/list:flex items-center gap-1.5">
							{onEditItem && (
								<button
									type="button"
									onClick={onEditItem}
									title="Item settings"
									className="w-[28px] h-[28px] rounded-md border border-border flex items-center justify-center text-text-muted hover:bg-surface hover:text-text-primary transition-colors"
								>
									<SquarePen size={13} />
									<span className="sr-only">Item Settings</span>
								</button>
							)}
							{onDelete && (
								<button
									type="button"
									onClick={onDelete}
									title="Delete item"
									className="w-[28px] h-[28px] rounded-md border border-border flex items-center justify-center text-text-muted hover:bg-surface hover:text-error-text transition-colors"
								>
									<Trash2 size={13} />
									<span className="sr-only">Delete</span>
								</button>
							)}
						</div>
					</div>

					{/* Kebab — hidden at wide widths unless QuickBooks has content only it can show. */}
					<div
						className={`relative ${hasQbMenuContent ? "" : "@min-[880px]/list:hidden"}`}
						ref={menuRef}
					>
						<button
							type="button"
							onClick={() => setMenuOpen((o) => !o)}
							aria-label={`More actions for ${item.name}`}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							className="w-[28px] h-[28px] rounded-md border border-border flex items-center justify-center text-text-muted hover:bg-surface hover:text-text-primary transition-colors"
						>
							<MoreHorizontal size={13} />
						</button>
						{menuOpen && (
							<div className="absolute right-0 top-full mt-1 w-44 bg-base border border-border rounded-lg shadow-lg z-50 py-1">
								{onEditItem && (
									<button
										type="button"
										onClick={() => { setMenuOpen(false); onEditItem(); }}
										className="w-full @min-[880px]/list:hidden flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
									>
										<SquarePen size={13} />
										Item Settings
									</button>
								)}
								{qbConnected && isLinkedToQB && (
									<div className="px-3 py-1.5 text-xs text-success-text flex items-center gap-2">
										QB Linked
									</div>
								)}
								{qbConnected && !isLinkedToQB && onLinkQB && (
									<button
										type="button"
										onClick={() => { setMenuOpen(false); onLinkQB?.(); }}
										className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
									>
										Link to QuickBooks
									</button>
								)}
								{onDelete && (
									<button
										type="button"
										onClick={() => { setMenuOpen(false); onDelete(); }}
										className="w-full @min-[880px]/list:hidden flex items-center gap-2 px-3 py-1.5 text-xs text-error-text hover:bg-surface transition-colors"
									>
										<Trash2 size={13} />
										Delete
									</button>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className={`p-5 w-full min-w-0 bg-base rounded-xl shadow-md border border-border-card relative cursor-pointer hover:border-border-strong transition-colors h-full flex flex-col ${isHighlighted ? "highlight-active" : ""}`}
			onClick={onClick}
			onMouseLeave={() => isHighlighted && onHighlightMouseLeave?.()}
		>

			<ImageCarousel images={item.image_urls ?? []} compact className="mb-2" />
			{/* Single wrapping flow: name → tracking badges → tags. */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
				<h3 className="font-bold text-lg min-w-0 break-words line-clamp-2" title={item.name}>
					{item.name}
				</h3>
				<TrackingBadges item={item} />
				{item.tags?.map((tag) => (
					<span
						key={tag.id}
						title={tag.label}
						className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface text-text-secondary border border-border-subtle max-w-full truncate"
					>
						{tag.label}
					</span>
				))}
			</div>
			<hr className="my-2 text-text-faint" />
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 flex-1">
				<FieldRow label="Location" value={<LocationValue location={item.location} />} />
				<FieldRow label="SKU" value={item.sku ?? "—"} />
				<FieldRow label="Unit Price" value={item.unit_price != null ? `$${Number(item.unit_price).toFixed(2)}` : "—"} />
				{/* Carries the unit: a bare "14" on an item measured in ft told a
				    dispatcher nothing about what 14 meant. */}
				<FieldRow label="Quantity" value={formatQty(item.quantity, item.unit)} />
			</div>
			<div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between gap-2 flex-wrap">
				<div className="flex items-center gap-2 flex-wrap min-w-0">
					<span
						className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${getStatusBadgeClass(stockStatus)}`}
					>
						{getStatusLabel(stockStatus)}
					</span>
					{/* Compact notation, exact figure in title — a full 10-digit threshold
					    pushed later content out of the card. */}
					<span
						className="text-xs text-text-tertiary shrink-0"
						title={threshold !== null ? `Alert threshold: ${threshold}` : undefined}
					>
						{threshold !== null ? `Alert: ${formatter.format(threshold)}` : "No alert set"}
					</span>
					{qbConnected &&
						(isLinkedToQB ? (
							<span
								className="inline-flex items-center p-1 rounded-full text-xs font-medium bg-success-bg text-success-text shrink-0"
								title="Linked to QuickBooks"
							>
								<Link2 size={13} />  <span className="pl-1">QB</span>
								<span className="sr-only">Linked to QuickBooks</span>
							</span>
						) : onLinkQB ? (
							<button
								onClick={(e) => {
									e.stopPropagation();
									onLinkQB();
								}}
								className="opacity-0 group-hover:opacity-100 transition-opacity rounded-md border border-border bg-surface p-1 text-xs font-medium text-text-primary hover:border-border-strong hover:bg-surface-raised shrink-0"
							>
								Link
							</button>
						) : null)}
				</div>
				<div className="flex items-center gap-1 shrink-0 ml-auto" onClick={(e) => e.stopPropagation()}>
					<AddToLabelQueueButton
						item={item}
						title="Add to label queue"
						className="p-1.5 hover:bg-surface text-text-tertiary hover:text-text-primary rounded-md transition-colors"
					>
						<span className="sr-only">Add to Label Queue</span>
					</AddToLabelQueueButton>
					{onEditItem && (
						<button
							onClick={onEditItem}
							className="p-1.5 hover:bg-surface text-text-tertiary hover:text-text-primary rounded-md transition-colors"
							title="Edit item"
						>
							<SquarePen size={14} />
							<span className="sr-only">Edit item</span>
						</button>
					)}
					{/* Delete last — harder to hit by accident than wedged between routine actions. */}
					{onDelete && (
						<button
							onClick={onDelete}
							className="p-1.5 hover:bg-surface text-text-tertiary hover:text-error-text rounded-md transition-colors"
							title="Delete item"
						>
							<Trash2 size={14} />
							<span className="sr-only">Delete</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

