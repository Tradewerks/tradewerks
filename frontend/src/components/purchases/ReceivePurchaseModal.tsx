import { useMemo, useState } from "react";
import { X, ScanLine, Loader2, Package, Wrench } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { BarcodeScanner } from "../inventory/BarcodeScanner";
import { useReceivePurchaseMutation } from "../../hooks/usePurchases";
import { useVehiclesQuery, useCreateVehicleMutation } from "../../hooks/useVehicles";
import CreateVehicle from "../vehicles/CreateVehicle";
import { useToast } from "../ui/useToast";
import { unitLabel } from "../../lib/units";
import { formatDateTime } from "../../util/util";
import type { Purchase, PurchaseLine } from "../../types/purchases";

const BTN_GHOST =
	"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors whitespace-nowrap";
const BTN_CONFIRM =
	"inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-confirm hover:bg-confirm-hover text-sm font-semibold text-on-primary transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";

interface ReceivePurchaseModalProps {
	isOpen: boolean;
	onClose: () => void;
	purchase: Purchase;
}

const isReceivable = (l: PurchaseLine) => l.disposition === "receive" || l.disposition === "non_stock";
const remainderOf = (l: PurchaseLine) => Math.max(0, Number(l.quantity) - Number(l.quantity_recieved));
const NEW_VEHICLE = "__new__";

// Only an item with no home gets an input. One that already lives on A42 is
// read-only here: the receive modal must never be able to move it, because
// location is a single value on the item, not a property of this delivery.
// A fully-received line's quantity input is disabled and it never enters
// `touched`, so a location typed into it would be silently dropped on submit
// — the input (and the bulk field it would justify) must not render at all.
const needsLocation = (l: PurchaseLine) =>
	!!l.inventory_item && !l.inventory_item.location && remainderOf(l) > 0;


export default function ReceivePurchaseModal({ isOpen, onClose, purchase }: ReceivePurchaseModalProps) {
	const toast = useToast();
	const { mutateAsync: receive, isPending } = useReceivePurchaseMutation();
	const { data: vehiclesData } = useVehiclesQuery();
	const vehicles = useMemo(() => vehiclesData ?? [], [vehiclesData]);
	const lines = useMemo(() => purchase.lines.filter(isReceivable), [purchase.lines]);

	const [drafts, setDrafts] = useState<Record<string, string>>(() =>
		Object.fromEntries(lines.map((l) => [l.id, remainderOf(l) > 0 ? String(remainderOf(l)) : ""])),
	);
	const [vehicleOverrides, setVehicleOverrides] = useState<Record<string, string>>(() =>
		Object.fromEntries(lines.map((l) => [l.id, l.disposition_vehicle_id ?? ""])),
	);
	const [vehicleForLine, setVehicleForLine] = useState<string | null>(null);
	const { mutateAsync: createVehicle } = useCreateVehicleMutation();
	const [isScannerOpen, setIsScannerOpen] = useState(false);
	const [locDrafts, setLocDrafts] = useState<Record<string, string>>({});
	const [bulkLoc, setBulkLoc] = useState("");

	// Only stock landing in the warehouse can give an item a home. A truck-bound
	// or job-costed line never touches a shelf — the server ignores a location
	// on one, so offering the input would be a silent no-op.
	const canSetLocation = (l: PurchaseLine) =>
		needsLocation(l) && l.disposition === "receive" && !vehicleOverrides[l.id];
	const anyCanSetLocation = lines.some(canSetLocation);

	const setDraft = (lineId: string, value: string, max: number) => {
		const cleaned = value.replace(/[^0-9.]/g, "");
		const num = Number(cleaned);
		if (cleaned !== "" && !Number.isNaN(num) && num > max) {
			setDrafts((prev) => ({ ...prev, [lineId]: String(max) }));
			return;
		}
		setDrafts((prev) => ({ ...prev, [lineId]: cleaned }));
	};

	// One scan = one unit toward whichever receivable line's linked item carries
	// that barcode — a box gets scanned, not typed.
	const handleScan = (code: string) => {
		const trimmed = code.trim();
		const line = lines.find((l) => l.inventory_item?.barcode && l.inventory_item.barcode === trimmed);
		if (!line) {
			toast.error(`No line on this order matches barcode "${trimmed}"`);
			return;
		}
		const max = remainderOf(line);
		if (max <= 0) {
			toast.info(`"${line.description}" is already fully received`);
			return;
		}
		setDrafts((prev) => {
			const current = Number(prev[line.id] || 0);
			return { ...prev, [line.id]: String(Math.min(max, current + 1)) };
		});
		toast.success(`Scanned: ${line.description}`);
	};

	const touched = lines.map((l) => ({ line: l, qty: Number(drafts[l.id]) })).filter((t) => t.qty > 0);
	// Selection stays on the previous destination until a vehicle is actually created.
	const setDestination = (lineId: string, value: string) => {
		if (value === NEW_VEHICLE) setVehicleForLine(lineId);
		else setVehicleOverrides((prev) => ({ ...prev, [lineId]: value }));
	};

	const handleSubmit = async () => {
		if (touched.length === 0) return;
		try {
			const { warnings } = await receive({
				id: purchase.id,
				data: {
					lines: touched.map((t) => {
						const loc = (locDrafts[t.line.id] || bulkLoc).trim();
						return {
							id: t.line.id,
							quantity_received: t.qty,
							...(t.line.disposition === "receive"
								? { disposition_vehicle_id: vehicleOverrides[t.line.id] || null }
								: {}),
							...(canSetLocation(t.line) && loc ? { location: loc } : {}),
						};
					}),
				},
			});
			toast.success("Purchase order updated");
			warnings.forEach((w) => toast.warning(w));
			// The modal stays mounted between opens, so a stale bulk value would
			// otherwise prefill the next delivery's unassigned lines.
			setBulkLoc("");
			setLocDrafts({});
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to receive purchase order");
		}
	};

	const allocationOf = (l: PurchaseLine) =>
		l.allocation_id ? purchase.allocations.find((a) => a.id === l.allocation_id) : undefined;

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<div>
					<h2 className="text-lg sm:text-xl font-bold text-text-primary">Receive Purchase Order</h2>
					<p className="text-xs text-text-muted mt-0.5">
						{purchase.purchase_number}
						{purchase.vendor_name ? ` · ${purchase.vendor_name}` : ""}
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors"
				>
					<X size={18} />
				</button>
			</div>

			<div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-2 flex-shrink-0">
				<button
					type="button"
					onClick={() => setIsScannerOpen(true)}
					className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-md border border-primary-border bg-primary-bg text-sm font-medium text-primary-text hover:bg-primary-bg-subtle transition-colors"
				>
					<ScanLine size={15} />
					Scan to receive
				</button>
			</div>

			{anyCanSetLocation && (
				<div className="px-4 sm:px-5 pb-2 flex-shrink-0">
					<label className="block text-xs text-text-muted mb-1">Put unassigned items in</label>
					<input
						type="text"
						value={bulkLoc}
						onChange={(e) => setBulkLoc(e.target.value.slice(0, 255))}
						placeholder="e.g. Receiving Dock"
						className="w-full h-9 px-3 rounded border border-border-input bg-base text-sm text-text-primary focus:border-primary focus:outline-none disabled:opacity-50"
						disabled={isPending}
					/>
				</div>
			)}

			<div className="px-4 sm:px-5 pb-4 space-y-2.5 overflow-y-auto" style={{ maxHeight: "50vh" }}>
				{lines.length === 0 && (
					<p className="text-sm text-text-muted py-6 text-center">Nothing left on this order to receive.</p>
				)}
				{lines.map((l) => {
					const max = remainderOf(l);
					const allocation = allocationOf(l);
					const missingVisit = l.disposition === "non_stock" && !allocation?.job_visit_id;
					const unit = unitLabel(l.inventory_item?.unit ?? "each");
					return (
						<div
							key={l.id}
							className={`rounded-lg border p-3 ${missingVisit ? "border-warning-border bg-warning-bg" : "border-border-subtle"}`}
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="text-sm font-semibold text-text-primary truncate">{l.description}</p>
									<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
										{l.disposition === "receive" ? (
											<span className="inline-flex items-center gap-1 rounded border border-primary-border bg-primary-bg px-1 py-0.5 text-[11px] font-semibold text-primary-text">
												<Package size={10} />
												Receive →
												<select
													value={vehicleOverrides[l.id] ?? ""}
													onChange={(e) => setDestination(l.id, e.target.value)}
													aria-label={`Receive "${l.description}" into`}
													className="bg-transparent text-[11px] font-semibold text-primary-text focus:outline-none [&>option]:bg-base [&>option]:text-text-primary"
												>
													<option value="">
														Warehouse
														{l.inventory_item?.location ? ` · ${l.inventory_item.location}` : ""}
													</option>
													{vehicles.map((v) => (
														<option key={v.id} value={v.id}>
															{v.name}
														</option>
													))}
													<option value={NEW_VEHICLE}>New vehicle…</option>
												</select>
											</span>
										) : (
											<span className="inline-flex items-center gap-1 rounded border border-reviewing/30 bg-reviewing/10 px-1.5 py-0.5 text-[11px] font-semibold text-reviewing-text">
												<Wrench size={10} />
												Job-costed
											</span>
										)}
										{allocation?.job && (
											<span>
												{allocation.job.job_number ? `#${allocation.job.job_number}` : allocation.job.name}
												{allocation.job_visit
													? ` · ${allocation.job_visit.name ?? formatDateTime(allocation.job_visit.scheduled_start_at ?? "")}`
													: ""}
											</span>
										)}
										{l.inventory_item?.location && <span>{l.inventory_item.location}</span>}
									</div>
								</div>
								<div className="flex flex-col items-end gap-1 flex-shrink-0">
									<div className="flex items-center gap-1.5">
										<input
											type="text"
											inputMode="decimal"
											value={drafts[l.id] ?? ""}
											onChange={(e) => setDraft(l.id, e.target.value, max)}
											disabled={max <= 0}
											aria-label={`Quantity received for ${l.description}`}
											className="w-16 h-8 text-right tabular-nums text-sm font-semibold border border-border-input rounded bg-base text-text-primary px-2 focus:border-primary focus:outline-none disabled:opacity-50"
										/>
										<span className="text-xs text-text-muted w-8">{unit}</span>
									</div>
									{canSetLocation(l) && (
										<input
											type="text"
											value={locDrafts[l.id] ?? ""}
											onChange={(e) =>
												setLocDrafts((prev) => ({
													...prev,
													[l.id]: e.target.value.slice(0, 255),
												}))
											}
											placeholder={bulkLoc || "Location (optional)"}
											aria-label={`Location for ${l.description}`}
											disabled={isPending}
											className="w-24 h-6 px-1.5 rounded border border-border-input bg-base text-[11px] text-text-primary focus:border-primary focus:outline-none disabled:opacity-50"
										/>
									)}
								</div>
							</div>
							<div className="mt-2 flex items-center gap-2">
								<div className="flex-1 h-1.5 rounded-full bg-surface-inset overflow-hidden">
									<div
										className="h-full rounded-full bg-border-strong"
										style={{
											width: `${Number(l.quantity) > 0 ? (Number(l.quantity_recieved) / Number(l.quantity)) * 100 : 0}%`,
										}}
									/>
								</div>
								<span className="text-[11px] text-text-muted tabular-nums whitespace-nowrap">
									{l.quantity_recieved} / {l.quantity} {unit} received
								</span>
							</div>
							{missingVisit && (
								<p className="mt-2 pt-2 border-t border-dashed border-warning-border text-[11px] text-warning-text">
									No job visit assigned yet — this can still be received, but its cost won't reach an
									invoice until a visit is set.
								</p>
							)}
						</div>
					);
				})}
			</div>

			<div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border bg-base flex-shrink-0">
				<span className="text-xs text-text-muted">
					{touched.length === 0
						? "No quantities entered"
						: `${touched.length} line${touched.length === 1 ? "" : "s"} will be received`}
				</span>
				<div className="flex items-center gap-2">
					<button type="button" onClick={onClose} disabled={isPending} className={BTN_GHOST}>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={isPending || touched.length === 0}
						className={BTN_CONFIRM}
					>
						{isPending && <Loader2 size={12} className="animate-spin" />}
						Receive
					</button>
				</div>
			</div>

			{isScannerOpen && <BarcodeScanner continuous onScan={handleScan} onClose={() => setIsScannerOpen(false)} />}
			<CreateVehicle
				isModalOpen={vehicleForLine !== null}
				setIsModalOpen={(open) => {
					if (!open) setVehicleForLine(null);
				}}
				createVehicle={async (input) => {
					const v = await createVehicle(input);
					if (vehicleForLine) setDestination(vehicleForLine, v.id);
					return v.id;
				}}
			/>
		</div>
	);

	return <FullPopup isModalOpen={isOpen} onClose={onClose} content={content} size="lg" />;
}
