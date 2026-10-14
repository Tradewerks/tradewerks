import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Plus, ScanLine, Split, Trash2 } from "lucide-react";
import { money } from "../../fieldPurchases/fieldPurchaseFormat";
import { OCR_LOW_CONFIDENCE, type FieldPurchase } from "../../../types/fieldPurchases";
import {
	blankLine,
	draftsFromOcr,
	pendingOcrLines,
	splitLine,
	type ExtractedReceiptLine,
	type LineDraft,
} from "./lineDrafts";
import LineStockDisclosure from "./LineStockDisclosure";
import RefundPartPicker, { RefundLineStock } from "./RefundPartPicker";
import { sheetCopy } from "./sheetCopy";

/** A job the receipt covers, as the line editor needs to name it. */
export interface LineJobOption {
	key: string;
	label: string;
}

interface Props {
	purchase: FieldPurchase;
	editable: boolean;
	lines: LineDraft[];
	onChange: (next: LineDraft[]) => void;
	/**
	 * The jobs on the roster. One job is the common case and the control stays
	 * hidden for it — the answer is not in doubt, and Flow A must not grow a step
	 * for the ordinary counter trip.
	 */
	jobs?: LineJobOption[];
	/**
	 * The truck the technician is signed onto. Seeds a stocked line's destination —
	 * the flow usually starts at that vehicle — and is the only vehicle a line may
	 * name at all.
	 */
	myVehicle?: { id: string; name: string } | null;
	/**
	 * What the receipt read. The server refuses to overwrite lines the technician
	 * entered, so an extraction that lost the race to their typing reaches them
	 * only through here — offered, never applied behind their back.
	 */
	extractedLines?: ExtractedReceiptLine[];
	/**
	 * The total and tax as the SHEET holds them, not as the server does. The
	 * technician types both at the counter and neither is persisted until submit,
	 * so checking against `purchase.total` never fired on the draft the check
	 * exists for - and on a pre-approved purchase it compared against the estimate.
	 */
	totalPaid?: number;
	taxAmount?: number;
}

/**
 * The lines, as part of the sheet rather than a form of their own. Controlled: the
 * parent holds the drafts and sends them with the one submit, so confirming a
 * line and editing it can't chase each other through separate saves.
 *
 * Mapping to a SKU stays optional; what happened to the part is asked either way,
 * because that is what bills the job.
 */
export default function PurchaseLineEditor({
	purchase,
	editable,
	lines,
	onChange,
	jobs = [],
	myVehicle,
	extractedLines = [],
	totalPaid = 0,
	taxAmount = 0,
}: Props) {
	const copy = sheetCopy(purchase.kind);
	// Null off a refund, so every refund-only branch below keys off this.
	const parentLines = purchase.kind === "refund" ? (purchase.parent?.lines ?? []) : null;
	const isSplit = jobs.length > 1;
	const linesTotal = lines.reduce(
		(n, d) => n + (Number(d.quantity) || 0) * (Number(d.unit_price) || 0),
		0
	);
	const pending = pendingOcrLines(extractedLines, lines);

	// Lines plus tax must reconcile to what was paid, within a cent — checked
	// here as well as at submit because here is
	// the only place it can still be fixed - at submit the technician has left the
	// counter. A cent of slack, for a receipt that rounds its own tax.
	const paid = totalPaid;
	const expected = linesTotal + taxAmount;
	const shortfall = paid > 0 ? paid - expected : 0;
	const mismatched = Math.abs(shortfall) > 0.01;
	const unconfirmed = lines.filter((l) => !l.acknowledged).length;
	const unassigned = lines.filter((l) => !l.allocationKey).length;

	// One summary region rather than a live region per line: OCR lands on every line
	// at once, and N regions announcing together is unreadable. The per-line marks
	// stay visual and are still reachable by navigating the line itself.
	const lowConfidenceCount = lines.filter(
		(l) =>
			!l.acknowledged &&
			l.ocrConfidence != null &&
			l.ocrConfidence < OCR_LOW_CONFIDENCE
	).length;

	// Pressing the offer is what unmounts it, so focus would fall to <body> and
	// drop a keyboard user at the top of the page - away from the very lines they
	// just asked for. Held as an index because the rows do not exist yet.
	const listRef = useRef<HTMLDivElement>(null);
	const [seedFrom, setSeedFrom] = useState<number | null>(null);
	useEffect(() => {
		if (seedFrom == null) return;
		listRef.current
			?.querySelector<HTMLInputElement>(`[data-line-index="${seedFrom}"]`)
			?.focus();
		setSeedFrom(null);
	}, [seedFrom]);

	const seedExtracted = () => {
		setSeedFrom(lines.length);
		onChange([
			...lines,
			...draftsFromOcr(pending, jobs.length === 1 ? jobs[0]!.key : ""),
		]);
	};

	const edit = (i: number, patch: Partial<LineDraft>) =>
		onChange(lines.map((d, j) => (j === i ? { ...d, ...patch } : d)));

	// The halves land next to each other, because the second one is only
	// intelligible beside the line it came out of.
	const split = (i: number) => {
		const other = jobs.find((j) => j.key !== lines[i]!.allocationKey) ?? jobs[0]!;
		const halves = splitLine(lines[i]!, other.key);
		onChange([...lines.slice(0, i), ...halves, ...lines.slice(i + 1)]);
	};

	return (
		<section className="rounded-xl border border-border bg-base p-4">
			<div className="mb-3 flex items-baseline justify-between">
				<h2 className="text-sm font-semibold text-text-primary">
					{copy.linesTitle}
				</h2>
				<span className="text-xs tabular-nums text-text-muted">
					{lines.length} line{lines.length === 1 ? "" : "s"} ·{" "}
					{money(linesTotal)}
				</span>
			</div>

			{/* Above the lines, because it is about lines that are not there. The
			    seeded rows land beside what was typed and each arrives unconfirmed,
			    so nothing is overwritten and submit stays blocked until they are
			    checked. */}
			{editable && pending.length > 0 && (
				<button
					type="button"
					onClick={seedExtracted}
					className="mb-3 flex w-full items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-left text-xs text-warning-text transition-colors duration-150 ease-out hover:border-warning"
				>
					<ScanLine aria-hidden size={14} className="flex-shrink-0" />
					<span className="min-w-0 flex-1">
						{pending.length} line
						{pending.length === 1 ? "" : "s"} read from the{" "}
						{copy.noun} {pending.length === 1 ? "is" : "are"} not on
						this sheet — add{" "}
						{pending.length === 1 ? "it" : "them"} to review
					</span>
				</button>
			)}

			{/* Both announcements share the one region: OCR lands on every line at
			    once, and regions announcing over each other read worse than one that
			    changes. */}
			<div role="status" aria-live="polite" className="sr-only">
				{[
					pending.length > 0
						? `${pending.length} line${pending.length === 1 ? "" : "s"} read from the ${copy.noun} ${pending.length === 1 ? "is" : "are"} not on this sheet yet.`
						: "",
					lowConfidenceCount > 0
						? `${lowConfidenceCount} line${lowConfidenceCount === 1 ? "" : "s"} read with low confidence — check ${lowConfidenceCount === 1 ? "it" : "them"} against the paper.`
						: "",
				]
					.filter(Boolean)
					.join(" ")}
			</div>

			{editable && parentLines && (
				<RefundPartPicker
					parentLines={parentLines}
					lines={lines}
					allocationKey={jobs.length === 1 ? jobs[0]!.key : ""}
					onChange={onChange}
				/>
			)}

			<div ref={listRef} className="space-y-3">
				{lines.map((d, i) => {
					const lowConfidence =
						d.ocrConfidence != null &&
						d.ocrConfidence < OCR_LOW_CONFIDENCE;
					return (
						<div
							key={d.key}
							className="rounded-lg border border-border bg-surface p-3"
							data-testid="purchase-line"
						>
							<div className="flex items-start gap-2">
								<input
									value={d.description}
									data-line-index={i}
									disabled={!editable}
									onChange={(e) =>
										edit(i, {
											description:
												e
													.target
													.value,
										})
									}
									placeholder={copy.linePlaceholder}
									className="h-11 min-w-0 flex-1 rounded-md border border-border bg-base px-2 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-60"
								/>
								{/* One counter item can genuinely serve two jobs, and the only
								    honest answer is two lines. Offered only where there is a
								    second job to send half of it to. */}
								{editable && isSplit && (
									<button
										type="button"
										aria-label={`Split ${d.description || "this line"} across two jobs`}
										onClick={() =>
											split(i)
										}
										className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text-primary"
									>
										<Split
											aria-hidden
											size={14}
										/>
									</button>
								)}
								{editable && (
									<button
										type="button"
										aria-label="Remove line"
										onClick={() =>
											onChange(
												lines.filter(
													(
														_,
														j
													) =>
														j !==
														i
												)
											)
										}
										className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-error-text"
									>
										<Trash2
											aria-hidden
											size={14}
										/>
									</button>
								)}
							</div>

							<div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
								<label>
									<span className="mb-1 block text-xs text-text-muted">
										Qty
									</span>
									<input
										value={d.quantity}
										disabled={!editable}
										inputMode="decimal"
										onChange={(e) =>
											edit(i, {
												quantity: e
													.target
													.value,
											})
										}
										className="h-11 w-full rounded-md border border-border bg-base px-2 text-sm tabular-nums text-text-primary disabled:opacity-60"
									/>
								</label>
								<label>
									<span className="mb-1 block text-xs text-text-muted">
										Unit price
									</span>
									<input
										value={d.unit_price}
										disabled={!editable}
										inputMode="decimal"
										onChange={(e) =>
											edit(i, {
												unit_price: e
													.target
													.value,
											})
										}
										className="h-11 w-full rounded-md border border-border bg-base px-2 text-sm tabular-nums text-text-primary disabled:opacity-60"
									/>
								</label>
								{/* Under the two it is derived from, so the pair a technician actually
								    types keeps the full width. */}
								<div className="col-span-2 sm:col-span-1">
									<span className="mb-1 block text-xs text-text-muted">
										Line
									</span>
									<p className="h-11 rounded-md border border-transparent px-2 text-sm leading-[2.75rem] tabular-nums text-text-secondary">
										{money(
											(Number(
												d.quantity
											) || 0) *
												(Number(
													d.unit_price
												) ||
													0)
										)}
									</p>
								</div>
							</div>

							{/* Only on a split receipt. With one job this is a question
							    with one answer, and asking it costs every ordinary
							    counter trip a step. */}
							{isSplit && (
								<label className="mt-2 block min-w-0">
									<span className="mb-1 block text-xs text-text-muted">
										Which job it was for
									</span>
									<select
										value={
											d.allocationKey
										}
										disabled={!editable}
										onChange={(e) =>
											edit(i, {
												allocationKey:
													e
														.target
														.value,
											})
										}
										className="h-11 w-full rounded-md border border-border bg-base px-2 text-sm text-text-primary disabled:opacity-60"
									>
										{/* Blank is a real state, not a placeholder: submit
										    refuses while any line is still on it. */}
										<option value="">
											Not said yet
										</option>
										{jobs.map((j) => (
											<option
												key={
													j.key
												}
												value={
													j.key
												}
											>
												{
													j.label
												}
											</option>
										))}
									</select>
								</label>
							)}

							{parentLines ? (
								<RefundLineStock
									draft={d}
									parentLines={parentLines}
								/>
							) : (
								<LineStockDisclosure
									draft={d}
									editable={editable}
									myVehicle={myVehicle}
									onChange={(patch) => edit(i, patch)}
								/>
							)}

							{lowConfidence && !d.acknowledged && (
								<p className="mt-2 inline-flex items-center gap-1 text-xs text-warning-text">
									<AlertTriangle
										aria-hidden
										size={12}
									/>{" "}
									Read with low confidence —
									check it against the paper
								</p>
							)}

							{editable && (
								<label className="-mx-1 mt-2 flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-text-secondary">
									<input
										type="checkbox"
										checked={
											d.acknowledged
										}
										onChange={(e) =>
											edit(i, {
												acknowledged:
													e
														.target
														.checked,
											})
										}
										className="h-5 w-5 accent-primary"
									/>
									This line matches the{" "}
									{copy.noun}
								</label>
							)}
							{!editable && d.acknowledged && (
								<p className="mt-2 inline-flex items-center gap-1 text-xs text-success">
									<Check
										aria-hidden
										size={12}
									/>{" "}
									Confirmed
								</p>
							)}
						</div>
					);
				})}
			</div>

			{editable && (
				<button
					type="button"
					onClick={() =>
						onChange([
							...lines,
							blankLine(
								jobs.length === 1
									? jobs[0]!.key
									: ""
							),
						])
					}
					className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-secondary hover:bg-surface-raised"
				>
					<Plus aria-hidden size={14} /> Add line
				</button>
			)}

			{editable && unconfirmed > 0 && (
				<p className="mt-2 text-xs text-text-muted">
					{unconfirmed} line{unconfirmed === 1 ? "" : "s"} still to
					check against the paper.
				</p>
			)}

			{/* Said here rather than only at the submit button: the fix is on these
			    rows, so the count belongs beside them. */}
			{editable && isSplit && unassigned > 0 && (
				<p className="mt-2 text-xs text-warning-text">
					{unassigned} line
					{unassigned === 1 ? " still needs" : "s still need"} a job —
					{parentLines
						? " nothing is credited for a line nobody claimed."
						: " nothing is billed for a line nobody claimed."}
				</p>
			)}

			{editable && mismatched && (
				// One string rather than interpolated fragments: it is a plain
				// sentence, and split across nodes it is read out in pieces.
				<p className="mt-2 text-xs text-warning-text">
					{`These lines plus tax do not add up to the ${money(paid)} ${copy.reconcileVerb} — ${money(
						Math.abs(shortfall)
					)} ${shortfall > 0 ? "is missing" : "is unaccounted for"}.`}
				</p>
			)}

			{purchase.ocr_line_count != null && purchase.ocr_status === "succeeded" && (
				<p className="mt-2 text-xs text-text-faint">
					{purchase.ocr_line_count} line
					{purchase.ocr_line_count === 1 ? "" : "s"} read from the
					photo.
				</p>
			)}
		</section>
	);
}
