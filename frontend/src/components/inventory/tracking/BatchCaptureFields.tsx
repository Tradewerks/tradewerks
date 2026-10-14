import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useBatchesQuery } from "../../../hooks/useTracking";
import type { BatchListRow } from "../../../types/tracking";

// The vendor is captured once per receipt (SupplierPicker), not per lot: the
// server writes the resolved supplier onto the new lot as well as the movement,
// so a second input here would only be a way to disagree with it.
export type BatchCaptureValue =
	| { mode: "new"; batch_number: string; expires_at: string | null }
	| { mode: "existing"; batch_id: string };

export interface BatchCaptureFieldsProps {
	itemId: string;
	value: BatchCaptureValue;
	onChange: (value: BatchCaptureValue) => void;
}

export const INPUT =
	"border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
export const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

export default function BatchCaptureFields({ itemId, value, onChange }: BatchCaptureFieldsProps) {
	const { data } = useBatchesQuery(itemId);
	const batches = useMemo(() => data?.batches ?? [], [data]);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	const selectedBatch: BatchListRow | undefined =
		value.mode === "existing" ? batches.find((b) => b.id === value.batch_id) : undefined;

	const displayText = value.mode === "new" ? value.batch_number : (selectedBatch?.batch_number ?? "");

	const suggestions = useMemo(() => {
		const q = displayText.trim().toLowerCase();
		if (!q) return batches;
		return batches.filter((b) => b.batch_number.toLowerCase().includes(q));
	}, [batches, displayText]);

	const findExactMatch = (text: string): BatchListRow | undefined =>
		batches.find((b) => b.batch_number.toLowerCase() === text.trim().toLowerCase());

	// Typing that exactly matches an open (non-recalled) lot switches into
	// "existing" mode automatically; anything else is treated as a brand-new
	// lot number. Explicitly clicking a dropdown suggestion does the same.
	const handleTextChange = (text: string) => {
		const exact = findExactMatch(text);
		if (exact && !exact.recalled_at) {
			onChange({ mode: "existing", batch_id: exact.id });
			return;
		}
		onChange({
			mode: "new",
			batch_number: text,
			expires_at: value.mode === "new" ? value.expires_at : null,
		});
	};

	const handleSelectBatch = (batch: BatchListRow) => {
		if (batch.recalled_at) return;
		onChange({ mode: "existing", batch_id: batch.id });
		setDropdownOpen(false);
	};

	const handleExpiresChange = (text: string) => {
		if (value.mode !== "new") return;
		onChange({ ...value, expires_at: text || null });
	};

	const isNew = value.mode === "new";

	return (
		<div className="space-y-2">
			<div className="relative min-w-0">
				<label className={LABEL}>Batch / Lot Number</label>
				<input
					type="text"
					value={displayText}
					onChange={(e) => handleTextChange(e.target.value)}
					onFocus={() => setDropdownOpen(true)}
					onBlur={() => setTimeout(() => setDropdownOpen(false), 120)}
					placeholder="e.g. LOT-2026-07"
					aria-label="Batch or lot number"
					className={INPUT}
				/>
				{dropdownOpen && suggestions.length > 0 && (
					<div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded border border-border bg-surface shadow-lg">
						{suggestions.map((b) => {
							const recalled = !!b.recalled_at;
							return (
								<button
									key={b.id}
									type="button"
									disabled={recalled}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => handleSelectBatch(b)}
									aria-label={
										recalled ? `${b.batch_number} (recalled)` : b.batch_number
									}
									className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm transition-colors ${
										recalled
											? "cursor-not-allowed text-text-faint"
											: "text-text-primary hover:bg-surface-raised"
									}`}
								>
									<span className="truncate">
										{b.batch_number}
										<span className="ml-1.5 text-xs text-text-muted">
											({b.qty_in_warehouse} in warehouse)
										</span>
									</span>
									{recalled && (
										<span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-error-text">
											<AlertTriangle size={11} />
											Recalled
										</span>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>

			<div className={`grid gap-2 min-w-0 ${isNew ? "grid-cols-1" : "grid-cols-2"}`}>
				<div className="min-w-0">
					<label className={LABEL}>Expires</label>
					{isNew ? (
						<input
							type="date"
							value={value.expires_at ?? ""}
							onChange={(e) => handleExpiresChange(e.target.value)}
							aria-label="Expiry date"
							className={INPUT}
						/>
					) : (
						<input
							type="text"
							readOnly
							disabled
							aria-label="Expiry date (read-only)"
							value={
								selectedBatch?.expires_at
									? selectedBatch.expires_at.slice(0, 10)
									: "No expiry set"
							}
							className={`${INPUT} text-text-muted cursor-not-allowed`}
						/>
					)}
				</div>
				{/* Only for an existing lot: the vendor is already recorded on it and
				    can't be changed by receiving more. A new lot takes its supplier
				    from the receipt's own picker. */}
				{!isNew && (
					<div className="min-w-0">
						<label className={LABEL}>Supplier</label>
						<input
							type="text"
							readOnly
							disabled
							aria-label="Supplier (read-only)"
							value={selectedBatch?.supplier ?? "—"}
							className={`${INPUT} text-text-muted cursor-not-allowed`}
						/>
					</div>
				)}
			</div>

			{!isNew && (
				<p className="text-xs text-text-muted">
					Receiving into existing lot {selectedBatch?.batch_number ?? ""}.
				</p>
			)}
		</div>
	);
}
