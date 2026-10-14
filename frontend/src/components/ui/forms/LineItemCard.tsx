import { memo, useState, useRef, useEffect, useMemo } from "react";
import {
	Trash2,
	RotateCcw,
	X,
	Briefcase,
	ChevronDown,
	ChevronRight,
	MapPin,
	Link2,
	AlertTriangle,
	Plus,
} from "lucide-react";
import {
	LineItemTypeValues,
	LineItemTypeLabels,
	LineItemDispositionLabels,
	type BaseLineItem,
	type LineItemDisposition,
} from "../../../types/common";
import type { InventoryItem } from "../../../types/inventory";
import { formatQty } from "../../../lib/units";
import type { TaxGroup } from "../../../types/tax";
import { useCreateProvisionalItemMutation } from "../../../hooks/useInventory";
import Dropdown from "../../ui/Dropdown";
import TaxGroupSelector from "./TaxGroupSelector";

// ── Shared primitives ─────────────────────────────────────────────────────────

const CheckIcon = () => (
	<svg width="7" height="5" viewBox="0 0 8 6" fill="none">
		<path
			d="M1 3L3 5L7 1"
			stroke="white"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

// ── Source context passed down from the invoice form ─────────────────────────
export interface SourceJob {
	id: string;
	job_number: string;
	name: string;
	visits: SourceVisit[];
}

export interface SourceVisit {
	id: string;
	scheduled_start_at: string | Date;
	status: string;
}

interface LineItemCardProps {
	item: BaseLineItem;
	index: number;
	isLoading: boolean;
	canRemove: boolean;
	onRemove: (id: string) => void;
	onUpdate: (id: string, field: keyof BaseLineItem, value: string | number) => void;
	onUpdateSource?: (
		id: string,
		sourceJobId: string | null,
		sourceVisitId: string | null
	) => void;
	dirtyFields?: Record<string, boolean>;
	onUndo?: (id: string, field: keyof BaseLineItem) => void;
	onClear?: (id: string, field: keyof BaseLineItem) => void;
	onUndoSource?: (id: string) => void;
	originalLineItemsMap?: Map<string, BaseLineItem>;
	sourceJobs?: SourceJob[];
	inventoryItems?: InventoryItem[];
	onLinkInventory?: (
		id: string,
		link: { inventory_item_id: string; name: string; unit_price: number | null } | null,
	) => void;
	taxGroups?: TaxGroup[];
	clientExempt?: boolean;
	onTaxChange?: (id: string, groupId: string | null, taxable: boolean) => void;
	/** Visit and recurring-plan forms only; other line kinds move no stock. */
	showDisposition?: boolean;
	/** Destinations a `receive` can land on, besides the warehouse. */
	vehicles?: { id: string; name: string }[];
	onDispositionChange?: (
		id: string,
		disposition: LineItemDisposition | null,
		vehicleId?: string | null,
	) => void;
}

function DispositionPicker({
	item,
	vehicles,
	onChange,
	disabled,
}: {
	item: BaseLineItem;
	vehicles: { id: string; name: string }[];
	onChange: (
		id: string,
		disposition: LineItemDisposition | null,
		vehicleId?: string | null,
	) => void;
	disabled: boolean;
}) {
	// Undefined and null both read as `consume`.
	const value: LineItemDisposition = item.disposition ?? "consume";

	return (
		<div className="mt-1 flex flex-wrap items-center gap-1.5">
			<select
				value={value}
				disabled={disabled}
				aria-label="Stock effect"
				onChange={(e) => {
					const next = e.target.value as LineItemDisposition;
					onChange(
						item.id,
						next,
						next === "receive" ? (item.disposition_vehicle_id ?? null) : null,
					);
				}}
				className="border border-border px-1.5 h-[22px] rounded bg-base text-[10px] text-text-secondary focus:outline-none focus:border-primary disabled:opacity-50 [&>option]:bg-base [&>option]:text-text-primary"
			>
				{(Object.keys(LineItemDispositionLabels) as LineItemDisposition[]).map((d) => (
					<option key={d} value={d}>
						{LineItemDispositionLabels[d]}
					</option>
				))}
			</select>

			{value === "receive" && (
				<select
					value={item.disposition_vehicle_id ?? ""}
					disabled={disabled}
					aria-label="Receive into"
					onChange={(e) => onChange(item.id, "receive", e.target.value || null)}
					className="border border-border px-1.5 h-[22px] rounded bg-base text-[10px] text-text-secondary focus:outline-none focus:border-primary disabled:opacity-50 [&>option]:bg-base [&>option]:text-text-primary"
				>
					{/* Defaulted by actor: a dispatcher filling this in is at the
					    warehouse. A tech's own purchase is already in their hands,
					    which is what the field-purchase flow defaults to. */}
					<option value="">Warehouse</option>
					{vehicles.map((v) => (
						<option key={v.id} value={v.id}>
							{v.name}
						</option>
					))}
				</select>
			)}

			{value === "non_stock" && (
				<span className="text-[10px] text-text-muted">
					Billed, never in our stock — nothing is deducted
				</span>
			)}
		</div>
	);
}

/**
 * Catalog picker for material and equipment lines. Selecting stores the
 * item's ID: the completion deduction, readiness gaps and charged-price
 * history all key off it, and a matching NAME alone is invisible to them.
 */
function InventoryPicker({
	item,
	inventoryItems,
	isLoading,
	onUpdate,
	onLink,
	onUndo,
	showUndo,
	untyped = false,
	showDisposition = false,
	vehicles = [],
	onDispositionChange,
}: {
	item: BaseLineItem;
	inventoryItems: InventoryItem[];
	isLoading: boolean;
	onUpdate: (id: string, field: keyof BaseLineItem, value: string | number) => void;
	onLink: (
		id: string,
		link: { inventory_item_id: string; name: string; unit_price: number | null } | null,
	) => void;
	onUndo?: (id: string, field: keyof BaseLineItem) => void;
	showUndo: boolean;
	/** No item type chosen yet — the line may still turn out to be labor. */
	untyped?: boolean;
	showDisposition?: boolean;
	vehicles?: { id: string; name: string }[];
	onDispositionChange?: (
		id: string,
		disposition: LineItemDisposition | null,
		vehicleId?: string | null,
	) => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	const filtered = useMemo(
		() =>
			inventoryItems
				.filter(
					(i) =>
						i.is_active &&
						(item.name.trim() === "" ||
							i.name.toLowerCase().includes(item.name.toLowerCase()) ||
							(i.sku && i.sku.toLowerCase().includes(item.name.toLowerCase())) ||
							(i.alt_ids?.some((id) => id.toLowerCase().includes(item.name.toLowerCase())) ?? false)),
				)
				.slice(0, 8),
		[inventoryItems, item.name],
	);

	// A just-quick-added item is provisional and the catalog list excludes
	// provisional rows, so a missing row is not an absent link.
	const isLinked = !!item.inventory_item_id;
	const linked = item.inventory_item_id
		? inventoryItems.find((i) => i.id === item.inventory_item_id)
		: undefined;

	// Shown inline because the price is editable right here — a dispatcher
	// discounting a part can see the floor before they cross it.
	const margin = useMemo(() => {
		const charged = Number(item.unit_price);
		if (!linked || linked.cost == null || charged <= 0) return null;
		const cost = Number(linked.cost);
		return { cost, charged, pct: ((charged - cost) / charged) * 100 };
	}, [linked, item.unit_price]);

	const quickAdd = useCreateProvisionalItemMutation();
	const typed = item.name.trim();
	// Hidden on an exact catalog name, which would only invite duplicates.
	const canQuickAdd =
		!isLinked &&
		typed.length > 0 &&
		!inventoryItems.some((i) => i.name.trim().toLowerCase() === typed.toLowerCase());

	const handleQuickAdd = async () => {
		try {
			const created = await quickAdd.mutateAsync({
				name: typed,
				unit_price: item.unit_price > 0 ? Number(item.unit_price) : undefined,
			});
			onLink(item.id, {
				inventory_item_id: created.id,
				name: created.name,
				// The new item was created from this price; re-applying it would clobber
				// a hand-edit.
				unit_price: null,
			});
			setIsOpen(false);
		} catch {
			// Left open: the failure message renders in it.
		}
	};

	const handleSelect = (invItem: InventoryItem) => {
		onLink(item.id, {
			inventory_item_id: invItem.id,
			name: invItem.name,
			unit_price: invItem.unit_price != null ? Number(invItem.unit_price) : null,
		});
		setIsOpen(false);
	};

	// Retyping the name breaks the link; useLineItems clears it on the same
	// update.
	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onUpdate(item.id, "name", e.target.value);
		setIsOpen(true);
	};

	return (
		<div ref={ref} className="relative min-w-0">
			<input
				type="text"
				placeholder="Search inventory *"
				value={item.name}
				onChange={handleChange}
				onFocus={() => setIsOpen(true)}
				disabled={isLoading}
				autoComplete="off"
				className="border border-border px-2.5 h-[34px] w-full rounded bg-surface-inset border-input text-primary placeholder:text-faint text-sm lg:text-base pr-8 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary-border"
			/>
			{showUndo && (
				<button
					type="button"
					title="Undo"
					onClick={() => onUndo!(item.id, "name")}
					className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
				>
					<RotateCcw size={14} />
				</button>
			)}
			{isOpen && (filtered.length > 0 || canQuickAdd) && (
				<div className="absolute top-full left-0 right-0 mt-1 bg-base border border-border rounded-lg shadow-xl z-50 overflow-hidden">
					<div className="max-h-44 overflow-y-auto">
						{filtered.map((invItem) => (
							<button
								key={invItem.id}
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									handleSelect(invItem);
								}}
								className="w-full px-3 py-2 text-left hover:bg-surface transition-colors"
							>
								<div className="text-sm text-text-primary truncate">{invItem.name}</div>
								<div className="text-[10px] text-text-muted">
									{invItem.sku && `${invItem.sku} · `}
									Qty: {formatQty(invItem.quantity, invItem.unit)}
									{invItem.unit_price != null &&
										` · $${Number(invItem.unit_price).toFixed(2)}`}
								</div>
							</button>
						))}

						{/* Escape hatch. A dispatcher pricing a job on the phone
						    must never be blocked because a part isn't catalogued
						    yet — that's what makes people type junk. This adds
						    it as provisional and links the line in one click. */}
						{canQuickAdd && (
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									void handleQuickAdd();
								}}
								disabled={quickAdd.isPending}
								className="w-full px-3 py-2 text-left border-t border-border hover:bg-surface transition-colors disabled:opacity-50"
							>
								<div className="flex items-center gap-1.5 text-sm text-primary-text">
									<Plus size={12} className="flex-shrink-0" />
									<span className="truncate">
										{quickAdd.isPending
											? "Adding…"
											: `Add "${item.name.trim()}" to inventory`}
									</span>
								</div>
								<div className="text-[10px] text-text-muted">
									Saved for review — needs cost and unit later
								</div>
							</button>
						)}
						{quickAdd.error instanceof Error && (
							<div className="px-3 py-2 border-t border-border text-[10px] text-error-text">
								{quickAdd.error.message}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Link status. An unlinked material is billable but invisible to
			    stock — say so here rather than letting it pass silently. */}
			<div className="mt-1 flex items-center gap-1.5 min-w-0">
				{isLinked ? (
					<>
						<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 border border-primary/40 text-[10px] text-primary-text min-w-0">
							<Link2 size={10} className="flex-shrink-0" />
							<span className="truncate">
								{linked ? (linked.sku ?? linked.name) : item.name}
							</span>
						</span>
						<span className="text-[10px] text-text-muted flex-shrink-0">
							{linked
								? `${formatQty(linked.quantity, linked.unit)} on hand`
								: "awaiting review"}
						</span>
						{margin && (
							<span
								title={`Catalog cost $${margin.cost.toFixed(2)} vs charged $${margin.charged.toFixed(2)}`}
								className={`text-[10px] flex-shrink-0 tabular-nums ${
									margin.pct < 0
										? "text-error-text"
										: margin.pct < 20
											? "text-warning-text"
											: "text-success-text"
								}`}
							>
								{margin.pct.toFixed(0)}% margin
							</span>
						)}
						<button
							type="button"
							title="Unlink from inventory"
							onClick={() => onLink(item.id, null)}
							disabled={isLoading}
							className="text-text-muted hover:text-error-text transition-colors flex-shrink-0"
						>
							<X size={11} />
						</button>
					</>
				) : untyped ? (
					// Untyped: the line may still turn out to be labor, so prompt rather than
					// warn about a consequence it may never have.
					<span className="text-[10px] text-text-muted">
						Search the catalog, or set a type below
					</span>
				) : (
					<span className="inline-flex items-center gap-1 text-[10px] text-warning-text">
						<AlertTriangle size={10} className="flex-shrink-0" />
						Not linked — won&apos;t deduct from stock
					</span>
				)}
			</div>

			{/* Only for a linked line: an unlinked one has no stock effect to
			    choose between, so the control would be inert. */}
			{showDisposition && isLinked && onDispositionChange && (
				<DispositionPicker
					item={item}
					vehicles={vehicles}
					onChange={onDispositionChange}
					disabled={isLoading}
				/>
			)}
		</div>
	);
}

const formatVisitDate = (d: string | Date) =>
	new Date(d).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

const LineItemCard = memo(
	({
		item,
		index,
		isLoading,
		canRemove,
		onRemove,
		onUpdate,
		onUpdateSource,
		dirtyFields = {},
		onUndo,
		onClear,
		onUndoSource,
		originalLineItemsMap,
		sourceJobs = [],
		inventoryItems,
		onLinkInventory,
		taxGroups = [],
		clientExempt = false,
		onTaxChange,
		showDisposition = false,
		vehicles = [],
		onDispositionChange,
	}: LineItemCardProps) => {
		const isDirty = (field: string) => dirtyFields[`li:${item.id}:${field}`];
		const showUndo = (field: keyof BaseLineItem) => !!onUndo && isDirty(field);
		const origItem = originalLineItemsMap?.get(item.id);
		const origHasSource = !!(origItem?.source_job_id || origItem?.source_visit_id);
		const isSourceDirty =
			!!onUndoSource && !!dirtyFields[`li:${item.id}:source`] && origHasSource;
		const showClear = (field: keyof BaseLineItem, value: string) =>
			!!onClear && value.trim().length > 0;

		const [sourceOpen, setSourceOpen] = useState(false);
		const [expandedSourceJobs, setExpandedSourceJobs] = useState<Set<string>>(
			new Set()
		);
		const sourceRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			if (!sourceOpen) return;
			const handleOutsideClick = (e: MouseEvent) => {
				if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) {
					setSourceOpen(false);
				}
			};
			document.addEventListener("mousedown", handleOutsideClick);
			return () => document.removeEventListener("mousedown", handleOutsideClick);
		}, [sourceOpen]);

		const sourceLabel = (() => {
			if (item.source_visit_id) {
				for (const job of sourceJobs) {
					const visit = job.visits.find(
						(v) => v.id === item.source_visit_id
					);
					if (visit) {
						return {
							type: "visit" as const,
							label: `${job.job_number} · ${formatVisitDate(visit.scheduled_start_at)}`,
							sublabel: visit.status,
						};
					}
				}
			}
			if (item.source_job_id) {
				const job = sourceJobs.find((j) => j.id === item.source_job_id);
				if (job)
					return {
						type: "job" as const,
						label: `${job.job_number} · ${job.name}`,
						sublabel: "Job-level",
					};
			}
			return null;
		})();

		const handleSelectJob = (jobId: string) => {
			onUpdateSource?.(item.id, jobId, null);
			setSourceOpen(false);
		};

		const handleSelectVisit = (jobId: string, visitId: string) => {
			onUpdateSource?.(item.id, jobId, visitId);
			setSourceOpen(false);
		};

		const handleClearSource = () => {
			onUpdateSource?.(item.id, null, null);
		};

		const toggleSourceJobExpanded = (jobId: string) => {
			setExpandedSourceJobs((prev) => {
				const next = new Set(prev);
				if (next.has(jobId)) next.delete(jobId);
				else next.add(jobId);
				return next;
			});
		};

		// Untyped lines get the picker too: people type WHAT THE THING IS before
		// they classify it, and picking an item sets the type itself. Choosing
		// labor or another non-stock type explicitly drops back to plain text,
		// since those corrupt every consumption-rate and reorder figure.
		const isInventoryType =
			!!onLinkInventory &&
			(!item.item_type ||
				item.item_type === "material" ||
				item.item_type === "equipment");

		return (
			<div className="p-2.5 lg:p-3 bg-surface rounded border border-border">
				{/* Header */}
				<div className="flex items-center justify-between mb-2">
					<span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Item {index + 1}
						{"isNew" in item && item.isNew ? (
							<span className="ml-2 text-primary-text normal-case font-normal tracking-normal">
								(new!)
							</span>
						) : null}
					</span>
					<button
						type="button"
						onClick={() => onRemove(item.id)}
						disabled={!canRemove || isLoading}
						className="text-error-text hover:text-error-text disabled:text-text-faint disabled:cursor-not-allowed transition-colors"
					>
						<Trash2 size={14} />
					</button>
				</div>

				<div className="space-y-2 min-w-0">
					{/* Row 1: Name */}
					<div className="relative min-w-0">
						{isInventoryType ? (
							<InventoryPicker
								item={item}
								inventoryItems={inventoryItems ?? []}
								isLoading={isLoading}
								onUpdate={onUpdate}
								onLink={onLinkInventory}
								untyped={!item.item_type}
								onUndo={onUndo}
								showUndo={showUndo("name")}
								showDisposition={showDisposition}
								vehicles={vehicles}
								onDispositionChange={onDispositionChange}
							/>
						) : (
							<>
								<input
									type="text"
									placeholder="Item name *"
									value={item.name}
									onChange={(e) =>
										onUpdate(
											item.id,
											"name",
											e.target.value
										)
									}
									disabled={isLoading}
									className="border border-border px-2.5 h-[34px] w-full rounded bg-surface-inset border-input text-primary placeholder:text-faint text-sm pr-8 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary-border"
								/>
								{showUndo("name") && (
									<button
										type="button"
										title="Undo"
										onClick={() =>
											onUndo!(
												item.id,
												"name"
											)
										}
										className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
									>
										<RotateCcw size={14} />
									</button>
								)}
							</>
						)}
					</div>

					{/* Row 2: Description */}
					<div className="relative min-w-0">
						<input
							type="text"
							placeholder="Description (optional)"
							value={item.description}
							onChange={(e) =>
								onUpdate(
									item.id,
									"description",
									e.target.value
								)
							}
							disabled={isLoading}
							className="border border-border px-2.5 h-[34px] w-full rounded bg-surface-inset border-input text-primary placeholder:text-faint text-sm pr-8 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary-border"
						/>
						{showUndo("description") ? (
							<button
								type="button"
								title="Undo"
								onClick={() =>
									onUndo!(
										item.id,
										"description"
									)
								}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
							>
								<RotateCcw size={14} />
							</button>
						) : showClear("description", item.description) ? (
							<button
								type="button"
								title="Clear"
								onClick={() =>
									onClear!(
										item.id,
										"description"
									)
								}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-error-text transition-colors"
							>
								<X size={14} />
							</button>
						) : null}
					</div>

					{/* Row 3: Item Type + Tax Group */}
					<div className="grid grid-cols-2 gap-2 min-w-0">
						<div className="relative min-w-0">
							<Dropdown
								entries={LineItemTypeValues.map(
									(type) => (
										<option
											key={type}
											value={type}
										>
											{LineItemTypeLabels[type]}
										</option>
									)
								)}
								value={item.item_type}
								onChange={(newValue) =>
									onUpdate(item.id, "item_type", newValue)
								}
								placeholder="Type (optional)"
								disabled={isLoading}
							/>
							{showUndo("item_type") ? (
								<button
									type="button"
									title="Undo"
									onClick={() => onUndo!(item.id, "item_type")}
									className="absolute right-9 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors z-10"
								>
									<RotateCcw size={14} />
								</button>
							) : showClear("item_type", item.item_type) ? (
								<button
									type="button"
									title="Clear"
									onClick={() => onClear!(item.id, "item_type")}
									className="absolute right-9 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-error-text transition-colors z-10"
								>
									<X size={14} />
								</button>
							) : null}
						</div>

						{onTaxChange && (
							<TaxGroupSelector
								value={item.tax_group_id ?? null}
								taxable={item.taxable ?? true}
								taxGroups={taxGroups}
								clientExempt={clientExempt}
								onChange={(groupId, taxable) =>
									onTaxChange(item.id, groupId, taxable)
								}
								disabled={isLoading}
							/>
						)}
					</div>

					{/* Row 4: Qty × Unit Price = Total on one line */}
					<div className="flex items-end gap-1.5 min-w-0">
						{/* Quantity */}
						<div className="relative w-[88px] flex-shrink-0">
							<label className="block mb-0.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
								Qty
							</label>
							<div className="relative">
								<input
									type="number"
									min="0.01"
									step="0.01"
									value={item.quantity}
									onChange={(e) =>
										onUpdate(
											item.id,
											"quantity",
											parseFloat(
												e
													.target
													.value
											) || 0
										)
									}
									disabled={isLoading}
									className="border border-border px-2 h-[34px] w-full rounded bg-surface-inset border-input text-primary text-sm text-center pr-8 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary-border [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								/>
								{showUndo("quantity") && (
									<button
										type="button"
										title="Undo"
										onClick={() =>
											onUndo!(
												item.id,
												"quantity"
											)
										}
										className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
									>
										<RotateCcw
											size={14}
										/>
									</button>
								)}
							</div>
						</div>

						{/* × operator */}
						<span className="pb-[9px] text-text-faint text-base font-light flex-shrink-0">
							×
						</span>

						{/* Unit Price */}
						<div className="relative flex-1 min-w-0">
							<label className="block mb-0.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
								Unit Price
							</label>
							<div className="relative">
								<span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-sm pointer-events-none">
									$
								</span>
								<input
									type="number"
									min="0"
									step="0.01"
									value={item.unit_price}
									onChange={(e) =>
										onUpdate(
											item.id,
											"unit_price",
											parseFloat(
												e
													.target
													.value
											) || 0
										)
									}
									disabled={isLoading}
									className="border border-border pl-6 pr-2 h-[34px] w-full rounded bg-surface-inset border-input text-primary text-sm min-w-0 focus:outline-none focus:ring-1 focus:ring-primary-border [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								/>
								{showUndo("unit_price") && (
									<button
										type="button"
										title="Undo"
										onClick={() =>
											onUndo!(
												item.id,
												"unit_price"
											)
										}
										className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
									>
										<RotateCcw
											size={12}
										/>
									</button>
								)}
							</div>
						</div>

						{/* = operator */}
						<span className="pb-[9px] text-text-faint text-base font-light flex-shrink-0">
							=
						</span>

						{/* Total — the hero number */}
						<div className="flex-shrink-0 w-[88px]">
							<label className="block mb-0.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider text-right">
								Total
							</label>
							<div className="h-[34px] flex items-center justify-end px-2.5 rounded border-2 border-primary/40 bg-base">
								<span className="text-sm font-bold text-text-primary tabular-nums">
									${item.total.toFixed(2)}
								</span>
							</div>
						</div>
					</div>

					{/* Row 5: Source Attribution (invoice context only) */}
					{sourceJobs.length > 0 && (
						<div className="min-w-0" ref={sourceRef}>
							<label className="block mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
								Attributed To
							</label>

							<button
								type="button"
								onClick={() =>
									setSourceOpen((v) => !v)
								}
								disabled={isLoading}
								className={`w-full flex items-center gap-2 px-2.5 h-[34px] rounded border text-sm text-left transition-colors min-w-0 ${
									sourceLabel
										? "border-primary/50 bg-primary/5 text-text-primary"
										: "border-border bg-base text-text-muted hover:border-border-strong"
								}`}
							>
								{sourceLabel ? (
									<>
										{sourceLabel.type ===
										"visit" ? (
											<MapPin
												size={
													12
												}
												className="text-primary-text flex-shrink-0"
											/>
										) : (
											<Briefcase
												size={
													12
												}
												className="text-primary-text flex-shrink-0"
											/>
										)}
										<span className="truncate text-xs flex-1 min-w-0">
											{
												sourceLabel.label
											}
										</span>
										<span className="text-text-muted text-xs flex-shrink-0 mr-1">
											{
												sourceLabel.sublabel
											}
										</span>
										<span
											role="button"
											aria-label="Remove attribution"
											onClick={(
												e
											) => {
												e.stopPropagation();
												handleClearSource();
											}}
											className="flex-shrink-0 text-text-muted hover:text-error-text transition-colors cursor-pointer"
										>
											<X
												size={
													12
												}
											/>
										</span>
									</>
								) : (
									<span className="text-xs flex-1">
										Unassigned
									</span>
								)}
								{isSourceDirty && (
									<span
										role="button"
										aria-label="Undo attribution"
										onClick={(e) => { e.stopPropagation(); onUndoSource!(item.id); }}
										className="flex-shrink-0 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
									>
										<RotateCcw size={12} />
									</span>
								)}
								<ChevronDown
									size={12}
									className={`flex-shrink-0 text-text-tertiary transition-transform ${sourceOpen ? "rotate-180" : ""}`}
								/>
							</button>

							{sourceOpen && (
								<div className="mt-1 border border-border rounded bg-base overflow-hidden">
									{sourceJobs.map((job) => {
										const isJobSelected =
											item.source_job_id ===
												job.id &&
											!item.source_visit_id;
										const isExpanded =
											expandedSourceJobs.has(
												job.id
											);

										return (
											<div
												key={
													job.id
												}
											>
												<div
													className={`flex items-center border-b border-border-subtle transition-colors ${
														isJobSelected
															? "bg-primary/10"
															: "hover:bg-surface"
													}`}
												>
													<button
														type="button"
														onClick={() =>
															handleSelectJob(
																job.id
															)
														}
														className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-1.5 text-left"
													>
														<div
															className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
																isJobSelected
																	? "border-primary bg-primary"
																	: "border-border-strong"
															}`}
														>
															{isJobSelected && <CheckIcon />}
														</div>
														<Briefcase
															size={
																11
															}
															className="text-text-tertiary flex-shrink-0"
														/>
														<span className="text-xs text-text-primary truncate">
															{
																job.job_number
															}{" "}
															·{" "}
															{
																job.name
															}
														</span>
														<span className="text-[10px] text-text-muted flex-shrink-0">
															job-level
														</span>
													</button>
													{job
														.visits
														.length >
														0 && (
														<button
															type="button"
															onClick={() =>
																toggleSourceJobExpanded(
																	job.id
																)
															}
															className="px-2.5 py-1.5 text-text-tertiary hover:text-text-primary border-l border-border-subtle flex-shrink-0 transition-colors"
														>
															{isExpanded ? (
																<ChevronDown
																	size={
																		12
																	}
																/>
															) : (
																<ChevronRight
																	size={
																		12
																	}
																/>
															)}
														</button>
													)}
												</div>

												{isExpanded &&
													job.visits.map(
														(
															visit
														) => {
															const isVisitSelected =
																item.source_visit_id ===
																visit.id;
															return (
																<button
																	key={
																		visit.id
																	}
																	type="button"
																	onClick={() =>
																		handleSelectVisit(
																			job.id,
																			visit.id
																		)
																	}
																	className={`w-full flex items-center gap-2 pl-7 pr-2.5 py-1.5 text-left border-b border-border-subtle transition-colors ${
																		isVisitSelected
																			? "bg-primary/10"
																			: "hover:bg-surface"
																	}`}
																>
																	<div
																		className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
																			isVisitSelected
																				? "border-primary bg-primary"
																				: "border-border-strong"
																		}`}
																	>
																		{isVisitSelected && <CheckIcon />}
																	</div>
																	<MapPin
																		size={
																			11
																		}
																		className="text-text-tertiary flex-shrink-0"
																	/>
																	<span className="text-xs text-text-secondary truncate">
																		{formatVisitDate(
																			visit.scheduled_start_at
																		)}
																	</span>
																	<span className="text-[10px] text-text-muted flex-shrink-0">
																		{
																			visit.status
																		}
																	</span>
																</button>
															);
														}
													)}
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		);
	}
);

LineItemCard.displayName = "LineItemCard";

export default LineItemCard;
export type { LineItemCardProps };
