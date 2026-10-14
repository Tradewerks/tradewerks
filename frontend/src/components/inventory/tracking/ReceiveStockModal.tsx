import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { isAxiosError } from "axios";
import type { InventoryItem } from "../../../types/inventory";
import type { ReceiveInventoryInput } from "../../../types/tracking";
import { useReceiveInventoryMutation } from "../../../hooks/useTracking";
import { useLabelQueueStore } from "../../../stores/labelQueueStore";
import { useToast } from "../../ui/useToast";
import SerialCaptureList from "./SerialCaptureList";
import BatchCaptureFields, { type BatchCaptureValue } from "./BatchCaptureFields";
import { isStorableStockQty } from "../stockQtyPrecision";
import SupplierPicker from "../SupplierPicker";
import type { SupplierCapture } from "../../../types/suppliers";

interface ReceiveStockModalProps {
	isOpen: boolean;
	onClose: () => void;
	item: Pick<InventoryItem, "id" | "name" | "is_serialized" | "is_batch_tracked">;
}

const INPUT =
	"w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const emptyBatch: BatchCaptureValue = {
	mode: "new",
	batch_number: "",
	expires_at: null,
};

// Standalone "Receive Stock" modal — the post-creation counterpart to the
// create wizard's capture step (CreateInventoryItem's handleAdvanceFromCapture).
// Reuses the same capture components + receive mutation so serials/batches can
// be added to an item that already exists.
export default function ReceiveStockModal({ isOpen, onClose, item }: ReceiveStockModalProps) {
	// A string, not a number: coercing on every keystroke snapped "0.5" to 1
	// and the native min=1/no-step input rejected "2.5" outright, so a batch-
	// tracked measured item could never receive a fractional quantity even
	// though the ledger stores 2 dp (review I7). Serialized items stay whole —
	// a serial is one indivisible unit.
	const [qty, setQty] = useState("1");
	const [serialValues, setSerialValues] = useState<string[]>([]);
	const [autoSerial, setAutoSerial] = useState(false);
	const [batchValue, setBatchValue] = useState<BatchCaptureValue>(emptyBatch);
	// Kept as a string, not a number: "" must stay distinguishable from 0 so a
	// blank field records "cost unknown" rather than a free purchase.
	const [unitCost, setUnitCost] = useState("");
	const [supplier, setSupplier] = useState<SupplierCapture>({});
	const [error, setError] = useState<string | null>(null);

	const receiveMutation = useReceiveInventoryMutation(item.id);
	const addToLabelQueue = useLabelQueueStore((s) => s.add);
	const toast = useToast();

	// Reset to a clean slate every time the modal opens so a prior receive's
	// values never leak into the next one.
	useEffect(() => {
		if (isOpen) {
			setQty("1");
			setSerialValues([]);
			setAutoSerial(false);
			setBatchValue(emptyBatch);
			setUnitCost("");
			setSupplier({});
			setError(null);
		}
	}, [isOpen, item.id]);

	if (!isOpen) return null;

	// Mirrors the backend: z.number().positive() + isStorableStockQty, and the
	// controller's whole-number rule for serialized items.
	const parsedQty = Number(qty.trim());
	const qtyError =
		qty.trim() === "" || !Number.isFinite(parsedQty) || parsedQty <= 0
			? "Quantity must be greater than 0."
			: item.is_serialized && !Number.isInteger(parsedQty)
				? "Quantity must be a whole number of units for a serialized item."
				: !isStorableStockQty(parsedQty)
					? "Quantity must be to two decimal places."
					: null;
	// Serial entry needs a whole count to size itself by; while the field is
	// blank or invalid it sizes to nothing rather than a guessed 1.
	const serialTarget = qtyError == null && Number.isInteger(parsedQty) ? parsedQty : 0;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (receiveMutation.isPending) return;
		setError(null);

		if (qtyError) {
			setError(qtyError);
			return;
		}
		// Mirrors handleAdvanceFromCapture's guards in CreateInventoryItem.
		// Auto-assign skips the per-unit entry (the backend synthesizes them).
		if (item.is_serialized && !autoSerial && serialValues.length !== serialTarget) {
			setError(
				`Enter exactly ${serialTarget} serial number${serialTarget === 1 ? "" : "s"} (currently ${serialValues.length}).`,
			);
			return;
		}
		if (item.is_batch_tracked && batchValue.mode === "new" && !batchValue.batch_number.trim()) {
			setError("Enter a batch/lot number.");
			return;
		}

		const parsedUnitCost = unitCost.trim() === "" ? null : Number(unitCost);
		if (parsedUnitCost != null && (!Number.isFinite(parsedUnitCost) || parsedUnitCost < 0)) {
			setError("Unit cost must be 0 or more, or left blank.");
			return;
		}

		const input: ReceiveInventoryInput = {
			qty: parsedQty,
			// Omitted when blank — the paid-cost history counts a receipt with no
			// recorded cost as unknown rather than averaging in a zero.
			...(parsedUnitCost != null ? { unit_cost: parsedUnitCost } : {}),
			// Optional everywhere: an unattributed receipt is better than a blocked one.
			...supplier,
			...(item.is_serialized
				? autoSerial
					? { auto_serial: true }
					: { serial_numbers: serialValues.map((s) => s.trim()) }
				: {}),
			...(item.is_batch_tracked
				? batchValue.mode === "existing"
					? { batch_id: batchValue.batch_id }
					: {
							batch: {
								batch_number: batchValue.batch_number.trim(),
								expires_at: batchValue.expires_at,
							},
						}
				: {}),
		};

		try {
			const result = await receiveMutation.mutateAsync(input);

			// Best-effort — mirrors the create wizard; never block on label-queue.
			try {
				for (const serial of result.created_serials ?? []) {
					addToLabelQueue({
						id: serial.id,
						code: serial.code,
						kind: "serial",
						primaryLabel: item.name,
						secondaryLabel: serial.serial_number,
					});
				}
				if (result.batch) {
					addToLabelQueue({
						id: result.batch.id,
						code: result.batch.code,
						kind: "batch",
						primaryLabel: item.name,
						secondaryLabel: result.batch.batch_number,
					});
				}
			} catch {
				// no-op
			}

			toast.success("Stock received");
			onClose();
		} catch (err) {
			console.error("Failed to receive stock:", err);
			let axiosMsg: string | undefined;
			if (isAxiosError(err)) {
				axiosMsg = err.response?.data?.error?.message;
			}
			const message = axiosMsg || (err instanceof Error ? err.message : "Failed to receive stock");
			setError(message);
			toast.error(message);
		}
	};

	return (
		<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
			<div className="bg-base rounded-xl p-6 w-full max-w-lg border border-border-subtle max-h-[90vh] overflow-y-auto scrollbar-hide">
				<div className="flex justify-between items-center mb-5">
					<div>
						<h2 className="text-2xl font-bold text-text-primary">Receive Stock</h2>
						<p className="text-sm text-text-tertiary mt-0.5">{item.name}</p>
					</div>
					<button
						onClick={onClose}
						className="text-text-tertiary hover:text-text-primary transition-colors"
						aria-label="Close"
					>
						<X size={24} />
					</button>
				</div>

				{/* noValidate: the quantity rules (positive, 2 dp, whole for serialized)
				    are checked in handleSubmit with the same messages as the rest of
				    this form, rather than the browser's generic step/min tooltip. */}
				<form onSubmit={handleSubmit} noValidate className="space-y-4">
					<div>
						<label htmlFor="receive-qty" className={LABEL}>
							Quantity
						</label>
						<input
							id="receive-qty"
							type="number"
							min={item.is_serialized ? 1 : 0.01}
							step={item.is_serialized ? 1 : 0.01}
							inputMode={item.is_serialized ? "numeric" : "decimal"}
							value={qty}
							onChange={(e) => setQty(e.target.value)}
							className={INPUT}
						/>
						{item.is_serialized && (
							<p className="text-xs text-text-muted mt-1">
								{autoSerial
									? `${serialTarget} serial number${serialTarget === 1 ? "" : "s"} will be auto-assigned.`
									: "Enter one serial number per unit below."}
							</p>
						)}
					</div>

					<div>
						<label htmlFor="receive-unit-cost" className={LABEL}>
							Unit cost paid <span className="normal-case">(optional)</span>
						</label>
						<input
							id="receive-unit-cost"
							type="number"
							min={0}
							step="0.01"
							placeholder="—"
							value={unitCost}
							onChange={(e) => setUnitCost(e.target.value)}
							className={INPUT}
						/>
						<p className="text-xs text-text-muted mt-1">
							What the supplier billed per unit on this receipt. Leave blank if
							unknown — it's recorded as unknown, not as zero.
						</p>
					</div>

					<div>
						<SupplierPicker value={supplier} onChange={setSupplier} />
						<p className="text-xs text-text-muted mt-1">
							Who this stock was bought from. Drives the cost origin on the
							item's price history.
						</p>
					</div>

					{item.is_serialized && (
						<div className="space-y-2">
							<label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
								<input
									type="checkbox"
									checked={autoSerial}
									onChange={(e) => setAutoSerial(e.target.checked)}
									className="h-4 w-4 rounded border-border bg-base text-primary focus:ring-primary cursor-pointer"
								/>
								Auto-assign serial numbers
							</label>
							{autoSerial ? (
								<p className="text-xs text-text-muted">
									Use this when units have no manufacturer serial — each gets a
									unique scannable code automatically.
								</p>
							) : (
								<SerialCaptureList
									itemId={item.id}
									targetCount={serialTarget}
									value={serialValues}
									onChange={setSerialValues}
								/>
							)}
						</div>
					)}

					{item.is_batch_tracked && (
						<BatchCaptureFields itemId={item.id} value={batchValue} onChange={setBatchValue} />
					)}

					{error && (
						<p className="text-sm text-error-text bg-error-bg border border-error-border rounded-md px-3 py-2">
							{error}
						</p>
					)}

					<div className="flex gap-3 pt-2">
						<button
							type="button"
							onClick={onClose}
							className="flex-1 px-4 py-2 bg-surface hover:bg-surface-raised text-text-primary rounded-md transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={receiveMutation.isPending}
							className="flex-1 px-4 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md transition-colors"
						>
							{receiveMutation.isPending ? "Receiving…" : "Receive Stock"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
