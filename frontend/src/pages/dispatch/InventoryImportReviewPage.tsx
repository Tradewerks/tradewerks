import { useState } from "react";
import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	CircleAlert,
	Clock3,
	DollarSign,
	LoaderCircle,
	LockKeyhole,
	RotateCcw,
	Search,
	ShieldCheck,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import CandidateReviewTable from "../../components/inventory/import/CandidateReviewTable";
import ImportSummaryCards from "../../components/inventory/import/ImportSummaryCards";
import {
	useApproveInventoryImportFinancials,
	useCommitInventoryImport,
	useInventoryImport,
	useInventoryImportCandidates,
	usePatchInventoryImportCandidate,
	useRetryInventoryImport,
	useUndoInventoryImport,
} from "../../hooks/useInventoryImports";
import type {
	CandidateFilters,
	InventoryImport,
	InventoryImportAction,
	InventoryImportStatus,
} from "../../types/inventoryImport";
import { usePermission } from "../../hooks/usePermission";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const STATUS_LABELS: Record<InventoryImportStatus, string> = {
	uploaded: "Waiting to start",
	processing: "Reading files",
	ready_for_review: "Ready to review",
	committing: "Updating inventory",
	committed: "Inventory updated",
	undoing: "Reversing changes",
	undone: "Import reversed",
	failed: "Needs attention",
	cancelled: "Cancelled",
};

function plural(count: number, singular: string, multiple = singular + "s"): string {
	return count === 1 ? singular : multiple;
}

function ReviewSteps({ record }: { record: InventoryImport }) {
	const approvalCount = record.financial_summary?.unapproved_count ?? 0;
	const reviewDone = record.conflict_count === 0 && record.low_confidence_count === 0;
	const approvalDone = approvalCount === 0;
	const finishReady = reviewDone && approvalDone && (record.actionable_count ?? 0) > 0;
	const reviewNeeds = [
		record.conflict_count > 0
			? record.conflict_count + " " + plural(record.conflict_count, "item") + " need a decision"
			: null,
		record.low_confidence_count > 0
			? record.low_confidence_count +
				" uncertain " +
				plural(record.low_confidence_count, "suggestion") +
				" need checking"
			: null,
	].filter(Boolean);
	const steps = [
		{
			title: "Review items",
			description: reviewDone
				? "All items have a clear action."
				: reviewNeeds.join("; ") + ".",
			done: reviewDone,
			active: !reviewDone,
		},
		{
			title: "Approve quantities and prices",
			description: approvalDone
				? "All quantity and price changes are approved."
				: approvalCount + " " + plural(approvalCount, "item") + " still need approval.",
			done: approvalDone,
			active: reviewDone && !approvalDone,
		},
		{
			title: "Finish import",
			description: finishReady
				? (record.actionable_count ?? 0) + " " + plural(record.actionable_count ?? 0, "item") + " are ready."
				: "Available after the first two steps are complete.",
			done: record.status === "committed",
			active: finishReady,
		},
	];

	return (
		<section aria-label="Import steps" className="overflow-hidden rounded-xl border border-border bg-base">
			<ol className="grid md:grid-cols-3 md:divide-x md:divide-border-subtle">
				{steps.map((step, index) => (
					<li
						key={step.title}
						className={"flex gap-3 border-b border-border-subtle px-5 py-4 last:border-b-0 md:border-b-0 " + (step.active ? "bg-primary-bg-subtle" : "")}
						aria-current={step.active ? "step" : undefined}
					>
						<span className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold " + (step.done ? "bg-success text-white" : step.active ? "bg-primary text-on-primary" : "bg-canvas text-muted")}>
							{step.done ? <CheckCircle2 size={16} /> : index + 1}
						</span>
						<div>
							<h2 className="text-sm font-medium text-text-primary">{step.title}</h2>
							<p className="mt-1 text-xs leading-4 text-muted">{step.description}</p>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

export default function InventoryImportReviewPage() {
	const { id } = useParams<{ id: string }>();
	const importId = id ?? "";
	const [filters, setFilters] = useState<CandidateFilters>({ page: 1, page_size: 50 });
	const recordQuery = useInventoryImport(importId);
	const candidatesQuery = useInventoryImportCandidates(importId, filters);
	const approve = useApproveInventoryImportFinancials(importId);
	const commit = useCommitInventoryImport(importId);
	const undo = useUndoInventoryImport(importId);
	const retry = useRetryInventoryImport(importId);
	const patch = usePatchInventoryImportCandidate(importId);
	const canManage = usePermission("manage_inventory");
	const record = recordQuery.data;
	const candidates = candidatesQuery.data?.items ?? [];

	const nonFinancialLowConfidence = candidates.filter(
		(candidate) =>
			candidate.low_confidence &&
			candidate.financial_fields.length === 0 &&
			candidate.proposed_action !== "conflict",
	);

	const bulkAccept = async () => {
		for (const candidate of nonFinancialLowConfidence) {
			await patch.mutateAsync({
				candidateId: candidate.id,
				input: { revision: candidate.revision, accept_non_financial: true },
			});
		}
	};

	if (!record && recordQuery.isLoading) {
		return (
			<div className="flex min-h-[50vh] items-center justify-center">
				<div className="text-center">
					<LoaderCircle className="mx-auto animate-spin text-link" />
					<p className="mt-3 text-sm text-muted">Opening your import…</p>
				</div>
			</div>
		);
	}
	if (!record) {
		return (
			<div className="p-8 text-error-text" role="alert">
				{recordQuery.error?.message ?? "We couldn't find this import."}
			</div>
		);
	}

	const isProcessing = record.status === "uploaded" || record.status === "processing";
	const canCommit =
		record.status === "ready_for_review" &&
		(record.blocking_count ?? 0) === 0 &&
		(record.actionable_count ?? 0) > 0;
	const canUndo =
		record.status === "committed" &&
		Boolean(record.undo_expires_at) &&
		new Date(record.undo_expires_at!).getTime() > Date.now();
	const financial = record.financial_summary;
	const hasReviewProblems = record.conflict_count > 0;

	return (
		<div className="mx-auto max-w-6xl space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="max-w-3xl">
					<Link
						to="/dispatch/inventory/imports"
						className="mb-3 inline-flex items-center gap-1 text-sm text-muted underline-offset-4 hover:text-link hover:underline"
					>
						<ArrowLeft size={14} /> Back to import history
					</Link>
					<h1 className="text-2xl font-semibold text-text-primary">Check items before adding them</h1>
					<p className="mt-2 text-sm leading-5 text-muted">
						Nothing has been added to inventory yet. Review the highlighted items, approve quantities
						and prices, then finish the import.
					</p>
					<p className="mt-2 text-sm text-secondary">
						Files: {record.sources.map((source) => source.original_filename).join(", ")}
					</p>
				</div>
				<span className="rounded-full border border-border bg-base px-3 py-1 text-sm text-secondary">
					{STATUS_LABELS[record.status]}
				</span>
			</header>

			{!canManage && (
				<div className="rounded-lg border border-info-border bg-info-bg p-4 text-sm text-info-text">
					You can view this import, but an inventory manager must make changes or finish it.
				</div>
			)}

			{isProcessing && (
				<section className="rounded-xl border border-border bg-base p-8 text-center sm:p-10">
					<LoaderCircle size={28} className="mx-auto animate-spin text-link" />
					<h2 className="mt-3 font-medium text-text-primary">Reading your files</h2>
					<p className="mx-auto mt-1 max-w-xl text-sm leading-5 text-muted">
						We're finding item details and checking for possible matches. You can leave this page and
						come back later.
					</p>
					<div className="mx-auto mt-5 max-w-xl space-y-2 text-left text-sm">
						{record.sources.map((source) => (
							<div key={source.id} className="flex justify-between gap-4 rounded-md bg-canvas px-3 py-2">
								<span className="truncate text-secondary">{source.original_filename}</span>
								<span className="shrink-0 capitalize text-muted">
									{source.extraction_status.replace(/_/g, " ")}
								</span>
							</div>
						))}
					</div>
				</section>
			)}

			{record.status === "failed" && (
				<section className="rounded-xl border border-error-border bg-error-bg p-5">
					<div className="flex gap-3">
						<AlertCircle className="shrink-0 text-error-text" />
						<div className="flex-1">
							<h2 className="font-medium text-error-text">We couldn't prepare this import</h2>
							<p className="mt-1 text-sm text-error-text">
								{record.error_message || "The file could not be read. Check the file and try again."}
							</p>
						</div>
					</div>
					{record.retryable && canManage && (
						<button
							type="button"
							onClick={() => retry.mutate(record.revision)}
							disabled={retry.isPending}
							className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
						>
							{retry.isPending ? "Trying again…" : "Try reading the files again"}
						</button>
					)}
				</section>
			)}

			{!isProcessing && record.status !== "failed" && (
				<>
					{record.status === "ready_for_review" && <ReviewSteps record={record} />}
					<ImportSummaryCards record={record} />

					{financial && financial.row_count > 0 && record.status === "ready_for_review" && (
						<section aria-labelledby="financial-approval-heading" className="rounded-xl border border-border bg-base p-5">
							<div className="flex flex-wrap items-start justify-between gap-5">
								<div className="max-w-2xl">
									<div className="flex items-center gap-2">
										<DollarSign size={18} className="text-link" />
										<h2 id="financial-approval-heading" className="font-medium text-text-primary">
											Approve quantities and prices
										</h2>
									</div>
									<p className="mt-2 text-sm leading-5 text-muted">
										Confirm the imported stock quantities and money values. Approval only unlocks
										the final step; it does not change inventory yet.
									</p>
									{hasReviewProblems && (
										<p className="mt-2 flex items-center gap-2 text-sm text-warning-text">
											<CircleAlert size={15} />
											Review the highlighted items below before approving these values.
										</p>
									)}
								</div>
								{financial.unapproved_count === 0 ? (
									<span className="inline-flex items-center gap-2 rounded-full bg-success-bg px-3 py-1.5 text-sm font-medium text-success-text">
										<CheckCircle2 size={15} /> Approved
									</span>
								) : canManage ? (
									<button
										type="button"
										onClick={() => approve.mutate({ revision: record.revision })}
										disabled={approve.isPending || hasReviewProblems}
										className="inline-flex items-center gap-2 rounded-md border border-primary bg-primary-bg px-4 py-2.5 text-sm font-medium text-link hover:bg-primary-bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
									>
										<ShieldCheck size={16} />
										{approve.isPending ? "Approving…" : "Approve quantities and prices"}
									</button>
								) : null}
							</div>
							<dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border-subtle pt-4 text-sm sm:grid-cols-4">
								<div>
									<dt className="text-xs text-muted">Total imported quantity</dt>
									<dd className="mt-1 font-medium tabular-nums text-text-primary">{financial.quantity_total}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted">Sum of unit costs</dt>
									<dd className="mt-1 font-medium tabular-nums text-text-primary">{money.format(financial.cost_total)}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted">Sum of selling prices</dt>
									<dd className="mt-1 font-medium tabular-nums text-text-primary">{money.format(financial.unit_price_total)}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted">Sum of receipt costs</dt>
									<dd className="mt-1 font-medium tabular-nums text-text-primary">{money.format(financial.cost_at_receipt_total)}</dd>
								</div>
							</dl>
							<p className="mt-4 text-xs text-muted">
								{financial.unapproved_count === 0
									? "All " + financial.row_count + " affected " + plural(financial.row_count, "row") + " approved."
									: financial.unapproved_count + " of " + financial.row_count + " affected " + plural(financial.row_count, "row") + " still need approval."}
							</p>
							{approve.error && <p className="mt-3 text-sm text-error-text" role="alert">{approve.error.message}</p>}
						</section>
					)}

					{record.status === "ready_for_review" && (
						<>
							<section aria-labelledby="import-items-heading" className="space-y-4">
								<div>
									<h2 id="import-items-heading" className="text-lg font-semibold text-text-primary">Items from your files</h2>
									<p className="mt-1 text-sm text-muted">
										Open anything marked “Needs review,” correct the details, and choose what should happen.
									</p>
								</div>
								<div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-base p-4">
									<label className="min-w-64 flex-1">
										<span className="mb-1 block text-xs font-medium text-secondary">Find an item</span>
										<span className="relative block">
											<Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
											<input
												value={filters.search ?? ""}
												onChange={(event) => setFilters((value) => ({ ...value, page: 1, search: event.target.value }))}
												placeholder="Search by name, SKU, or barcode"
												className="h-10 w-full rounded-md border border-border-input bg-canvas pl-9 pr-3 text-sm text-text-primary"
											/>
										</span>
									</label>
									<label>
										<span className="mb-1 block text-xs font-medium text-secondary">Show</span>
										<select
											value={filters.action ?? ""}
											onChange={(event) => setFilters((value) => ({
												...value,
												page: 1,
												action: (event.target.value || undefined) as InventoryImportAction | undefined,
											}))}
											className="h-10 rounded-md border border-border-input bg-canvas px-3 text-sm text-secondary"
										>
											<option value="">All items</option>
											<option value="create">New items</option>
											<option value="update">Existing item updates</option>
											<option value="conflict">Needs review</option>
											<option value="skip">Won't be imported</option>
										</select>
									</label>
									<label className="flex h-10 items-center gap-2 text-sm text-secondary">
										<input
											type="checkbox"
											checked={filters.low_confidence === true}
											onChange={(event) => setFilters((value) => ({
												...value,
												page: 1,
												low_confidence: event.target.checked ? true : undefined,
											}))}
										/>
										Only uncertain suggestions
									</label>
									{canManage && nonFinancialLowConfidence.length > 0 && (
										<button
											type="button"
											onClick={() => void bulkAccept()}
											disabled={patch.isPending}
											className="h-10 rounded-md border border-border px-3 text-sm font-medium text-secondary hover:bg-canvas disabled:opacity-50"
										>
											<CheckCircle2 size={14} className="mr-1 inline" /> Accept suggestions shown
										</button>
									)}
								</div>

								{candidatesQuery.isLoading ? (
									<p className="p-8 text-center text-sm text-muted">Loading items…</p>
								) : (
									<CandidateReviewTable importId={importId} candidates={candidates} readOnly={!canManage} />
								)}
								<div className="flex items-center justify-between text-sm text-muted">
									<span>{candidatesQuery.data?.total ?? 0} {plural(candidatesQuery.data?.total ?? 0, "item")}</span>
									<div className="flex gap-2">
										<button
											type="button"
											disabled={(filters.page ?? 1) <= 1}
											onClick={() => setFilters((value) => ({ ...value, page: Math.max(1, (value.page ?? 1) - 1) }))}
											className="rounded-md border border-border px-3 py-1.5 hover:bg-base disabled:opacity-40"
										>
											Previous
										</button>
										<button
											type="button"
											disabled={!candidatesQuery.data?.hasMore}
											onClick={() => setFilters((value) => ({ ...value, page: (value.page ?? 1) + 1 }))}
											className="rounded-md border border-border px-3 py-1.5 hover:bg-base disabled:opacity-40"
										>
											Next
										</button>
									</div>
								</div>
							</section>

							{canManage && (
								<section className={"flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5 " + (canCommit ? "border-success-border bg-success-bg" : "border-border bg-base")}>
									<div className="max-w-2xl">
										<h2 className="flex items-center gap-2 font-medium text-text-primary">
											{canCommit ? <CheckCircle2 size={18} className="text-success" /> : <LockKeyhole size={18} className="text-muted" />}
											{canCommit
												? "Ready to add items to inventory"
												: (record.blocking_count ?? 0) + " " + plural(record.blocking_count ?? 0, "item") + " still need attention"}
										</h2>
										<p className="mt-1 text-sm leading-5 text-muted">
											{canCommit
												? "Finish the import to apply all approved changes together. You'll have time to reverse a clean import afterward."
												: "Review the highlighted items and approve quantities and prices to unlock the final step."}
										</p>
									</div>
									<button
										type="button"
										onClick={() => commit.mutate(record.revision)}
										disabled={!canCommit || commit.isPending}
										className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
									>
										{commit.isPending ? "Finishing import…" : "Finish import"}
									</button>
									{commit.error && <p className="w-full text-sm text-error-text" role="alert">{commit.error.message}</p>}
								</section>
							)}
						</>
					)}

					{record.status === "committed" && (
						<section className="rounded-xl border border-success-border bg-success-bg p-5">
							<div className="flex flex-wrap items-center justify-between gap-4">
								<div className="flex gap-3">
									<CheckCircle2 className="text-success" />
									<div>
										<h2 className="font-medium text-text-primary">Inventory updated</h2>
										<p className="text-sm text-secondary">All approved item and stock changes were applied together.</p>
										{record.undo_expires_at && (
											<p className="mt-1 text-xs text-muted">
												<Clock3 size={12} className="mr-1 inline" />
												You can reverse this import until {new Date(record.undo_expires_at).toLocaleString()}.
											</p>
										)}
									</div>
								</div>
								{canManage && (
									<button
										type="button"
										onClick={() => undo.mutate()}
										disabled={!canUndo || undo.isPending}
										className="inline-flex items-center gap-2 rounded-md border border-border bg-base px-4 py-2 text-sm font-medium text-secondary hover:bg-canvas disabled:opacity-40"
									>
										<RotateCcw size={15} />
										{undo.isPending ? "Reversing…" : canUndo ? "Reverse this import" : "Reversal window expired"}
									</button>
								)}
							</div>
							{undo.error && <p className="mt-3 text-sm text-error-text" role="alert">{undo.error.message}</p>}
						</section>
					)}
					{record.status === "undone" && (
						<div className="rounded-xl border border-border bg-base p-5 text-sm text-secondary">
							<RotateCcw size={16} className="mr-2 inline" />
							Import reversed. Inventory has been restored.
						</div>
					)}
				</>
			)}
		</div>
	);
}
