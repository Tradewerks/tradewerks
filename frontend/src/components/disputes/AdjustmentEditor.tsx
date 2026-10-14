import { Plus, Trash2 } from "lucide-react";
import { formatCurrency } from "../../util/util";
import {
	blankAdjustmentLine,
	draftFromLineItem,
	draftRowError,
	draftTotal,
	isPristineBlank,
	netAdjustment,
	type AdjustmentDraft,
	type AdjustmentKind,
	type AttributionTarget,
	type DisputeLineItem,
} from "./adjustmentDraft";

interface AdjustmentEditorProps {
	/** The document's own lines — the thing being corrected. */
	lineItems: DisputeLineItem[];
	drafts: AdjustmentDraft[];
	onChange: (next: AdjustmentDraft[]) => void;
	/** The root invoice's billed jobs and visits. When there is more than one,
	 *  each row must name the one it credits or the server 422s the submit (D4);
	 *  one or none is attributed server-side with no picker. */
	attributionTargets?: AttributionTarget[];
}

/** value string <-> AttributionTarget: `job:<id>` / `visit:<id>`. */
const targetValue = (t: AttributionTarget) => `${t.kind}:${t.id}`;

const LABEL = "block text-xs font-medium text-text-tertiary uppercase tracking-wide";
const FIELD =
	"px-2.5 py-1.5 bg-surface-inset border border-border rounded-md text-sm text-text-primary placeholder:text-faint focus:outline-none focus:border-primary transition-colors duration-150 ease-out";

const KINDS: AdjustmentKind[] = ["credit", "charge"];
const KIND_LABEL: Record<AdjustmentKind, string> = { credit: "Credit", charge: "Charge" };

export default function AdjustmentEditor({
	lineItems,
	drafts,
	onChange,
	attributionTargets = [],
}: AdjustmentEditorProps) {
	const credited = new Set(
		drafts
			.filter((row) => row.kind === "credit")
			.map((row) => row.originLineId)
			.filter((id): id is string => id !== null)
	);
	const net = netAdjustment(drafts);
	// D4: with one target the server attributes silently; with several the
	// dispatcher must pick, or attributeAdjustmentLines 422s the whole submit.
	const requireAttribution = attributionTargets.length > 1;

	const patch = (key: string, next: Partial<AdjustmentDraft>) =>
		onChange(drafts.map((row) => (row.key === key ? { ...row, ...next } : row)));

	const patchTarget = (key: string, value: string) => {
		const picked = attributionTargets.find((t) => targetValue(t) === value);
		patch(key, {
			sourceJobId: picked
				? picked.kind === "job"
					? picked.id
					: (picked.jobId ?? null)
				: null,
			sourceVisitId: picked && picked.kind === "visit" ? picked.id : null,
		});
	};

	const addFromLine = (line: DisputeLineItem) => {
		const row = draftFromLineItem(line);
		// Replacing the starter row rather than appending: picking a line as the
		// first act otherwise leaves an empty invalid row under the credit.
		const [first] = drafts;
		const replaceStarter =
			drafts.length === 1 && first !== undefined && isPristineBlank(first);
		onChange(replaceStarter ? [row] : [...drafts, row]);
	};

	return (
		<div className="space-y-4">
			{lineItems.length > 0 && (
				<div>
					<p className={LABEL}>This document's lines</p>
					<p className="mt-1 mb-2 text-xs text-text-tertiary">
						Credit a line and it keeps that line's price, tax
						group and job link.
					</p>
					<div className="space-y-1.5 max-h-44 overflow-y-auto">
						{lineItems.map((line) => {
							const added = credited.has(line.id);
							return (
								<div
									key={line.id}
									className="flex items-center gap-2.5 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm"
								>
									<span className="min-w-0 flex-1 truncate text-text-primary">
										{line.name}
									</span>
									<span className="flex-shrink-0 tabular-nums text-text-tertiary">
										{formatCurrency(
											line.total
										)}
									</span>
									<button
										type="button"
										disabled={added}
										onClick={() =>
											addFromLine(
												line
											)
										}
										className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-text-secondary transition-colors duration-150 ease-out hover:enabled:border-primary hover:enabled:text-primary-text disabled:opacity-40 disabled:cursor-not-allowed"
									>
										{added
											? "Added"
											: "Credit this line"}
									</button>
								</div>
							);
						})}
					</div>
				</div>
			)}

			<div>
				<p className={LABEL}>What are you crediting?</p>

				{/* Column headings, matching the row widths below. Without them
				    the editor is four unlabelled boxes in a row. */}
				<div className="mt-2 mb-1 flex items-center gap-2 text-xs text-text-muted">
					<span
						className="w-[108px] flex-shrink-0"
						aria-hidden="true"
					/>
					<span className="min-w-0 flex-1">Description</span>
					<span className="w-14 flex-shrink-0 text-right">Qty</span>
					<span className="w-24 flex-shrink-0 text-right">
						Unit price
					</span>
					<span className="w-24 flex-shrink-0 text-right">Total</span>
					<span className="w-6 flex-shrink-0" aria-hidden="true" />
				</div>

				<div className="space-y-2.5">
					{drafts.map((row, index) => {
						const total = draftTotal(row);
						const error = draftRowError(row, requireAttribution);
						const currentTarget =
							row.sourceVisitId != null
								? `visit:${row.sourceVisitId}`
								: row.sourceJobId != null
									? `job:${row.sourceJobId}`
									: "";
						return (
							<div key={row.key}>
								<div className="flex items-center gap-2">
									<div
										role="group"
										aria-label={`Line ${index + 1} direction`}
										className="flex w-[108px] flex-shrink-0 rounded-md border border-border p-0.5"
									>
										{KINDS.map(
											(kind) => (
												<button
													key={
														kind
													}
													type="button"
													aria-pressed={
														row.kind ===
														kind
													}
													onClick={() =>
														patch(
															row.key,
															{
																kind,
															}
														)
													}
													className={`flex-1 rounded px-1.5 py-1 text-xs font-medium transition-colors duration-150 ease-out ${
														row.kind ===
														kind
															? kind ===
																"credit"
																? "bg-primary-bg-subtle text-primary-text"
																: "bg-warning-bg text-warning-text"
															: "text-text-muted hover:text-text-secondary"
													}`}
												>
													{
														KIND_LABEL[
															kind
														]
													}
												</button>
											)
										)}
									</div>
									<input
										type="text"
										value={row.name}
										onChange={(e) =>
											patch(
												row.key,
												{
													name: e
														.target
														.value,
												}
											)
										}
										aria-label={`Line ${index + 1} description`}
										placeholder="The client will see this"
										className={`min-w-0 flex-1 ${FIELD}`}
									/>
									<input
										type="number"
										step="any"
										min="0"
										aria-label={`Line ${index + 1} quantity`}
										value={row.quantity}
										onChange={(e) =>
											patch(
												row.key,
												{
													quantity: e
														.target
														.value,
												}
											)
										}
										className={`w-14 flex-shrink-0 text-right tabular-nums ${FIELD}`}
									/>
									<input
										type="number"
										step="0.01"
										min="0"
										aria-label={`Line ${index + 1} unit price`}
										value={
											row.unitPrice
										}
										onChange={(e) =>
											patch(
												row.key,
												{
													unitPrice: e
														.target
														.value,
												}
											)
										}
										className={`w-24 flex-shrink-0 text-right tabular-nums ${FIELD}`}
									/>
									<span
										aria-live="polite"
										className={`w-24 flex-shrink-0 text-right text-sm tabular-nums ${
											total < 0
												? "text-error-text"
												: "text-text-primary"
										}`}
									>
										{formatCurrency(
											total
										)}
									</span>
									<button
										type="button"
										aria-label={`Remove line ${index + 1}`}
										onClick={() =>
											onChange(
												drafts.filter(
													(
														r
													) =>
														r.key !==
														row.key
												)
											)
										}
										className="w-6 flex-shrink-0 rounded-md p-1 text-text-muted transition-colors duration-150 ease-out hover:bg-surface hover:text-error-text"
									>
										<Trash2 size={14} />
									</button>
								</div>

								{/* Provenance, not decoration: a seeded row and a
								    hand-typed one are taxed and attributed
								    differently and used to look identical. */}
								<p className="mt-1 pl-[116px] text-xs text-text-muted">
									{row.originName != null ? (
										<>
											{row.kind ===
											"credit"
												? "Credits "
												: "Charges against "}
											{
												row.originName
											}
											{row.originTaxGroupName !=
												null &&
												` · tax group ${row.originTaxGroupName}`}
											{(row.sourceJobId !=
												null ||
												row.sourceVisitId !=
													null) &&
												" · keeps its job link"}
										</>
									) : (
										"Manual line · uses the default tax group, not linked to a job"
									)}
								</p>

								{requireAttribution && (
									<div className="mt-1 pl-[116px]">
										<select
											aria-label={`Line ${index + 1} job or visit`}
											value={currentTarget}
											onChange={(e) =>
												patchTarget(
													row.key,
													e.target.value
												)
											}
											className={`${FIELD} w-full max-w-xs`}
										>
											<option value="">
												Which job or visit does this
												credit?
											</option>
											{attributionTargets.map((t) => (
												<option
													key={targetValue(t)}
													value={targetValue(t)}
												>
													{t.label}
												</option>
											))}
										</select>
									</div>
								)}

								{error != null && (
									<p className="mt-0.5 pl-[116px] text-xs text-error-text">
										{error}
									</p>
								)}
							</div>
						);
					})}
				</div>

				<button
					type="button"
					onClick={() => onChange([...drafts, blankAdjustmentLine()])}
					className="mt-2 flex items-center gap-1.5 text-xs font-medium text-primary-text transition-colors duration-150 ease-out hover:text-primary"
				>
					<Plus size={13} />
					Add line
				</button>

				<div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-2.5">
					<span className={LABEL}>Net adjustment</span>
					<span
						className={`text-sm font-semibold tabular-nums ${
							net < 0
								? "text-error-text"
								: "text-text-primary"
						}`}
					>
						{formatCurrency(net)}
					</span>
				</div>

				{/* The sign above is the mechanism; this is the consequence, and
				    it is the last chance to catch a credit toggled to a charge. */}
				{net !== 0 && (
					<p
						className={`mt-1.5 text-xs ${
							net > 0
								? "text-warning-text"
								: "text-text-tertiary"
						}`}
					>
						{net < 0
							? `The client will be credited ${formatCurrency(Math.abs(net))}.`
							: `The client will be charged an extra ${formatCurrency(net)}.`}
					</p>
				)}

				{net === 0 && (
					<p className="mt-1.5 text-xs text-text-muted">
						The net can't be zero — a correction that changes
						nothing writes a document for nothing.
					</p>
				)}
			</div>
		</div>
	);
}
