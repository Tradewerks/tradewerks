import { useId, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import CatalogItemPicker from "../../inventory/CatalogItemPicker";
import { DISPOSITION_LABELS, type FieldPurchaseDisposition } from "../../../types/fieldPurchases";
import type { LineDraft } from "./lineDrafts";

/**
 * What becomes of the part, kept off the transcription path. A technician reading
 * the paper top to bottom types a description, a quantity, a price and a job; where
 * the part ended up and which SKU it maps to are inventory's questions, and asking
 * them inline put three more controls between one receipt line and the next.
 *
 * Folded away, never dropped: `disposition` is the sole gate on billing the visit
 * and on stock intake, so the summary states it out loud on every line — and warns
 * on the one value that does neither.
 */
export default function LineStockDisclosure({
	draft,
	editable,
	myVehicle,
	onChange,
}: {
	draft: LineDraft;
	editable: boolean;
	/**
	 * The truck this technician is signed onto — the only vehicle a field purchase
	 * can stock. The fleet is not offered here: the server refuses a purchase that
	 * stocks another crew's van, so offering that choice would only be offering
	 * one that fails on submit.
	 */
	myVehicle?: { id: string; name: string } | null;
	onChange: (patch: Partial<LineDraft>) => void;
}) {
	// An unrecorded line bills nobody and stocks nothing. Opening it is the only
	// way a collapsed group can still ask the question.
	const [open, setOpen] = useState(draft.disposition === "");
	const panelId = useId();

	const summary =
		draft.disposition === "receive"
			? {
					text: draft.disposition_vehicle_id
						? `To ${myVehicle?.name ?? "your truck"}`
						: "To Warehouse",
					warn: false,
				}
			: draft.disposition === "non_stock"
				? { text: "Billed to job", warn: false }
				: { text: "Not recorded", warn: true };

	return (
		<div className="mt-2 rounded-md border border-border">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((o) => !o)}
				className="flex min-h-11 w-full items-center gap-2 px-2.5 text-left"
			>
				<ChevronDown
					aria-hidden
					size={14}
					className={`flex-shrink-0 text-text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
				/>
				<span className="flex-shrink-0 text-xs text-text-muted">
					Stock &amp; billing
				</span>
				<span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
					{draft.item && (
						<span className="min-w-0 truncate text-xs text-text-faint">
							{draft.item.name}
						</span>
					)}
					{/* Paired with an icon rather than carried by the colour alone:
					    this row is scanned down a list of lines, and the whole
					    point of the warn state is that it stands out. */}
					<span
						className={`inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium ${summary.warn ? "text-warning-text" : "text-text-secondary"}`}
					>
						{summary.warn && (
							<AlertTriangle aria-hidden size={12} />
						)}
						{summary.text}
					</span>
				</span>
			</button>

			{open && (
				<div
					id={panelId}
					className="grid gap-2 border-t border-border p-2.5 sm:grid-cols-2"
				>
					<label className="min-w-0">
						<span className="mb-1 block text-xs text-text-muted">
							What happened to it
						</span>
						<select
							value={draft.disposition}
							disabled={!editable}
							onChange={(e) =>
								onChange({
									disposition: e.target
										.value as
										| FieldPurchaseDisposition
										| "",
									...(e.target.value ===
									"receive"
										? {
												disposition_vehicle_id:
													draft.disposition_vehicle_id ||
													(myVehicle?.id ??
														""),
											}
										: {
												disposition_vehicle_id:
													"",
											}),
								})
							}
							className="h-11 w-full rounded-md border border-border bg-base px-2 text-sm text-text-primary disabled:opacity-60"
						>
							<option value="">Not recorded</option>
							{(
								Object.keys(
									DISPOSITION_LABELS
								) as FieldPurchaseDisposition[]
							).map((k) => (
								<option key={k} value={k}>
									{DISPOSITION_LABELS[k]}
								</option>
							))}
						</select>
					</label>

					{draft.disposition === "receive" && (
						<div className="min-w-0">
							<span
								id={`${panelId}-dest`}
								className="mb-1 block text-xs text-text-muted"
							>
								Goes onto
							</span>
							{/* Two answers, so both are on screen at once rather than
							    behind a picker: one tap at a counter, gloved, instead of
							    open-scroll-select. */}
							<div
								role="radiogroup"
								aria-labelledby={`${panelId}-dest`}
								className="flex overflow-hidden rounded-md border border-border"
							>
								{[
									{
										id: "",
										label: "Warehouse",
									},
									...(myVehicle
										? [
												{
													id: myVehicle.id,
													label: myVehicle.name,
												},
											]
										: []),
								].map((opt, i) => {
									const active =
										draft.disposition_vehicle_id ===
										opt.id;
									return (
										<button
											key={
												opt.id ||
												"warehouse"
											}
											type="button"
											role="radio"
											aria-checked={
												active
											}
											disabled={
												!editable
											}
											onClick={() =>
												onChange(
													{
														disposition_vehicle_id:
															opt.id,
													}
												)
											}
											className={`min-h-11 min-w-0 flex-1 truncate px-2 text-sm font-medium transition-colors disabled:opacity-60 ${
												i >
												0
													? "border-l border-border"
													: ""
											} ${
												active
													? "bg-primary text-on-primary"
													: "bg-base text-text-secondary hover:bg-surface"
											}`}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
							{/* Warehouse is always a legitimate answer, so nothing here
							    blocks the line — a technician with no truck assigned just
							    has one destination, and is told why rather than left
							    wondering where their van went. */}
							{!myVehicle && (
								<span className="mt-1 block text-xs text-text-muted">
									No truck assigned — ask
									dispatch to sign you onto
									one to stock it.
								</span>
							)}
						</div>
					)}

					<div className="min-w-0 sm:col-span-2">
						<span className="mb-1 block text-xs text-text-muted">
							Catalog item (optional)
						</span>
						{/* Searched on the server. This was a native select holding every
						    item in the catalog, once per line — no search, no SKU, no
						    cost, and a scroll to the bottom of the whole catalog to
						    reach the fields underneath it. */}
						<CatalogItemPicker
							scope="catalog"
							value={draft.item}
							disabled={!editable}
							ariaLabel="Catalog item for this line"
							placeholder="Search the catalog…"
							onChange={(t) =>
								onChange({
									item: t,
									inventory_item_id:
										t?.id ?? "",
								})
							}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
