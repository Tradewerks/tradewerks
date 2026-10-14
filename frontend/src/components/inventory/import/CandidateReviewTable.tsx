import { useMemo, useState } from "react";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	CircleHelp,
	Image,
	Layers3,
	Save,
} from "lucide-react";
import { useAllInventoryQuery } from "../../../hooks/useInventory";
import { usePatchInventoryImportCandidate } from "../../../hooks/useInventoryImports";
import type {
	InventoryImportAction,
	InventoryImportCandidate,
	InventoryImportIssue,
} from "../../../types/inventoryImport";
import SourceEvidence from "./SourceEvidence";

const EDITABLE_FIELDS = [
	"name", "description", "location", "quantity", "unit", "sku", "barcode", "category",
	"cost", "unit_price", "cost_at_receipt", "low_stock_threshold", "tags", "alt_ids",
	"is_serialized", "is_batch_tracked", "serial_numbers", "lot_number", "external_id",
	"source_namespace",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const CORE_FIELDS: EditableField[] = [
	"name", "description", "location", "quantity", "unit", "sku", "barcode", "category",
	"cost", "unit_price", "low_stock_threshold",
];
const MORE_FIELDS: EditableField[] = [
	"cost_at_receipt", "tags", "alt_ids", "is_serialized", "is_batch_tracked",
	"serial_numbers", "lot_number", "external_id", "source_namespace",
];
const NUMERIC_FIELDS = new Set<EditableField>(["quantity", "cost", "unit_price", "cost_at_receipt", "low_stock_threshold"]);
const ARRAY_FIELDS = new Set<EditableField>(["tags", "alt_ids", "serial_numbers"]);
const BOOLEAN_FIELDS = new Set<EditableField>(["is_serialized", "is_batch_tracked"]);

const FIELD_LABELS: Record<EditableField, string> = {
	name: "Item name",
	description: "Description",
	location: "Storage location",
	quantity: "On-hand quantity",
	unit: "Stocking unit",
	sku: "SKU",
	barcode: "Barcode or UPC",
	category: "Category",
	cost: "Unit cost",
	unit_price: "Selling price",
	cost_at_receipt: "Cost when received",
	low_stock_threshold: "Low-stock alert at",
	tags: "Tags",
	alt_ids: "Alternate IDs",
	is_serialized: "Track individual serial numbers",
	is_batch_tracked: "Track by lot or batch",
	serial_numbers: "Serial numbers",
	lot_number: "Lot or batch number",
	external_id: "ID from the source system",
	source_namespace: "Source system name",
};

const ACTION_OPTIONS: Array<{
	value: Exclude<InventoryImportAction, "conflict">;
	label: string;
	description: string;
}> = [
	{ value: "create", label: "Add as a new item", description: "Use this when the product is not already in inventory." },
	{ value: "update", label: "Update an existing item", description: "Choose the inventory item this row belongs to." },
	{ value: "skip", label: "Don't import this row", description: "Nothing from this row will be added or changed." },
];

const ACTION_LABELS: Record<InventoryImportAction, string> = {
	create: "New item",
	update: "Update existing item",
	skip: "Won't be imported",
	conflict: "Needs review",
};

function display(value: unknown): string {
	if (value == null || value === "") return "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function editableDisplay(value: unknown): string {
	if (value == null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

function plural(count: number, singular: string, multiple = singular + "s"): string {
	return count === 1 ? singular : multiple;
}

function friendlyIssueMessage(issue: InventoryImportIssue): string {
	const label = FIELD_LABELS[issue.field as EditableField] ?? "value";
	if (issue.code === "REQUIRED") return "Enter a " + label.toLowerCase() + ".";
	if (issue.code === "INVALID_NUMBER") return "Enter a valid " + label.toLowerCase() + ".";
	if (issue.code === "NEGATIVE") return label + " cannot be negative.";
	if (issue.code === "INVALID_PRECISION") {
		return "Use up to 2 decimal places and no more than 8 digits before the decimal for " +
			label.toLowerCase() + ".";
	}
	if (issue.code === "UNKNOWN_UNIT") return "Enter a recognized stocking unit, such as each, box, or foot.";
	if (issue.code === "TRACKING_REQUIRED" && issue.field === "serial_numbers") {
		return "Enter one serial number for each unit.";
	}
	if (issue.code === "TRACKING_REQUIRED" && issue.field === "lot_number") {
		return "Enter a lot or batch number.";
	}
	return "Check the " + label.toLowerCase() + ".";
}

function CandidateCard({
	importId,
	candidate,
	readOnly,
}: {
	importId: string;
	candidate: InventoryImportCandidate;
	readOnly: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const merged = useMemo(
		() => ({ ...candidate.normalized_proposal, ...candidate.user_overrides }),
		[candidate],
	);
	const initialDraft = useMemo(
		() => Object.fromEntries(
			EDITABLE_FIELDS.map((field) => [field, editableDisplay(merged[field])]),
		) as Record<EditableField, string>,
		[merged],
	);
	const [draft, setDraft] = useState<Record<EditableField, string>>(() => initialDraft);
	const [action, setAction] = useState<InventoryImportAction>(candidate.proposed_action);
	const [existingItemId, setExistingItemId] = useState(candidate.existing_item_id ?? "");
	const [variantApproved, setVariantApproved] = useState(
		candidate.user_overrides.variant_group_approved === true,
	);
	const [photoApproved, setPhotoApproved] = useState(
		candidate.user_overrides.photo_attachment_approved === true,
	);
	const inventory = useAllInventoryQuery();
	const patch = usePatchInventoryImportCandidate(importId);
	const itemName = String(merged.name || "Item name missing");
	const needsReview = candidate.proposed_action === "conflict" || candidate.validation_issues.length > 0;
	const hasMoreFieldIssue = candidate.validation_issues.some((issue) =>
		MORE_FIELDS.includes(issue.field as EditableField),
	);

	const save = async () => {
		const values: Record<string, unknown> = {};
		for (const field of EDITABLE_FIELDS) {
			const value = draft[field] ?? "";
			if (value === initialDraft[field]) continue;
			values[field] = NUMERIC_FIELDS.has(field)
				? (value === "" ? null : Number(value))
				: ARRAY_FIELDS.has(field)
					? value.split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean)
					: BOOLEAN_FIELDS.has(field)
						? value === "true"
						: value;
		}
		if (candidate.variant_group_suggestion) {
			values.variant_group_approved = variantApproved;
			if (variantApproved && candidate.variant_group_suggestion.display_name) {
				values.variant_group_name = candidate.variant_group_suggestion.display_name;
			}
		}
		if (candidate.matching_evidence.photo_review_required === true) {
			values.photo_attachment_approved = photoApproved;
		}
		try {
			await patch.mutateAsync({
				candidateId: candidate.id,
				input: {
					revision: candidate.revision,
					proposed_action: action,
					existing_item_id: action === "update" ? existingItemId || null : null,
					...(Object.keys(values).length ? { values } : {}),
				},
			});
			setExpanded(false);
		} catch {
			// The mutation exposes its actionable error next to the save button.
		}
	};

	const renderField = (field: EditableField) => {
		const confidence = candidate.field_confidence[field];
		const fieldIssue = candidate.validation_issues.some((issue) => issue.field === field);
		return (
			<label key={field} className="block">
				<span className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
					<span>{FIELD_LABELS[field]}</span>
					{confidence != null && confidence < 0.8 && (
						<span className="inline-flex items-center gap-1 text-warning-text">
							<CircleHelp size={12} /> Check this value
						</span>
					)}
				</span>
				{BOOLEAN_FIELDS.has(field) ? (
					<select
						disabled={readOnly}
						value={draft[field] ?? "false"}
						onChange={(event) => setDraft((value) => ({ ...value, [field]: event.target.value }))}
						aria-invalid={fieldIssue}
						className="h-10 w-full rounded-md border border-border-input bg-canvas px-3 text-sm text-text-primary disabled:opacity-70"
					>
						<option value="false">No</option>
						<option value="true">Yes</option>
					</select>
				) : (
					<input
						disabled={readOnly}
						type={NUMERIC_FIELDS.has(field) ? "number" : "text"}
						step={NUMERIC_FIELDS.has(field) ? "0.01" : undefined}
						value={draft[field] ?? ""}
						onChange={(event) => setDraft((value) => ({ ...value, [field]: event.target.value }))}
						placeholder={ARRAY_FIELDS.has(field) ? "Separate multiple values with commas" : undefined}
						aria-invalid={fieldIssue}
						className="h-10 w-full rounded-md border border-border-input bg-canvas px-3 text-sm text-text-primary aria-[invalid=true]:border-error disabled:opacity-70"
					/>
				)}
			</label>
		);
	};

	return (
		<article className={"overflow-hidden rounded-xl border bg-base " + (needsReview ? "border-warning-border" : "border-border")}>
			<div className="flex flex-wrap items-center gap-3 p-4">
				<label className="flex shrink-0 items-center gap-2 text-xs text-muted">
					<input
						type="checkbox"
						checked={candidate.selected}
						disabled={readOnly}
						onChange={(event) => patch.mutate({
							candidateId: candidate.id,
							input: { revision: candidate.revision, selected: event.target.checked },
						})}
						aria-label={"Include " + itemName + " in this import"}
					/>
					<span className="hidden sm:inline">Include</span>
				</label>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="truncate font-medium text-text-primary">{itemName}</h3>
						<span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + (needsReview ? "bg-warning-bg text-warning-text" : "bg-canvas text-secondary")}>
							{ACTION_LABELS[candidate.proposed_action]}
						</span>
						{candidate.low_confidence && (
							<span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] text-warning-text">
								Check suggested values
							</span>
						)}
						{candidate.requires_financial_approval && !candidate.financial_approved_at && (
							<span className="rounded-full bg-primary-bg px-2 py-0.5 text-[11px] text-link">
								Quantity or price approval needed
							</span>
						)}
					</div>
					<div className="mt-1">
						<SourceEvidence candidate={candidate} />
					</div>
				</div>
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-secondary hover:bg-canvas"
					aria-expanded={expanded}
					aria-label={(expanded ? "Close review for " : "Review ") + itemName}
				>
					{expanded ? "Close" : needsReview ? "Review item" : "View or edit"}
					{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
				</button>
			</div>

			{!expanded && candidate.validation_issues.length > 0 && (
				<div className="flex items-start gap-2 border-t border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text">
					<AlertTriangle size={16} className="mt-0.5 shrink-0" />
					<p>
						{candidate.validation_issues.length} {plural(candidate.validation_issues.length, "problem")} to fix.
						{" "}{friendlyIssueMessage(candidate.validation_issues[0])}
					</p>
				</div>
			)}

			{expanded && (
				<div className="space-y-5 border-t border-border p-4 sm:p-5">
					{candidate.validation_issues.length > 0 && (
						<div className="rounded-lg border border-error-border bg-error-bg p-4" role="alert">
							<h4 className="flex items-center gap-2 font-medium text-error-text">
								<AlertTriangle size={16} /> Fix before continuing
							</h4>
							<ul className="mt-2 space-y-1 text-sm text-error-text">
								{candidate.validation_issues.map((issue) => (
									<li key={issue.field + "-" + issue.code}>{friendlyIssueMessage(issue)}</li>
								))}
							</ul>
						</div>
					)}

					<div className="grid gap-6 xl:grid-cols-12">
						<section className="xl:col-span-4">
							<h4 className="font-medium text-text-primary">Original file values</h4>
							<p className="mt-1 text-xs text-muted">Use these values to compare with the item details.</p>
							<dl className="mt-3 max-h-80 space-y-2 overflow-auto rounded-lg bg-canvas p-4 text-xs">
								{Object.entries(candidate.raw_values).map(([key, value]) => (
									<div key={key} className="grid grid-cols-[minmax(7rem,0.8fr)_1.2fr] gap-3">
										<dt className="text-muted">{key}</dt>
										<dd className="break-words text-secondary">{display(value)}</dd>
									</div>
								))}
							</dl>
						</section>

						<section className="xl:col-span-5">
							<h4 className="font-medium text-text-primary">Item details</h4>
							<p className="mt-1 text-xs text-muted">Correct anything that does not match the source file.</p>
							<div className="mt-3 grid gap-3 sm:grid-cols-2">
								{CORE_FIELDS.map(renderField)}
							</div>
							<details className="mt-4 rounded-lg border border-border" open={hasMoreFieldIssue}>
								<summary className="cursor-pointer px-4 py-3 text-sm font-medium text-secondary">
									More fields and tracking
								</summary>
								<div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
									{MORE_FIELDS.map(renderField)}
								</div>
							</details>
						</section>

						<section className="xl:col-span-3">
							<h4 className="font-medium text-text-primary">What should happen?</h4>
							<p className="mt-1 text-xs text-muted">Choose one option for this row.</p>
							<div className="mt-3 space-y-2">
								{ACTION_OPTIONS.map((option) => (
									<label
										key={option.value}
										className={"flex cursor-pointer gap-3 rounded-lg border p-3 " + (action === option.value ? "border-primary bg-primary-bg" : "border-border hover:bg-canvas")}
									>
										<input
											type="radio"
											name={"action-" + candidate.id}
											value={option.value}
											checked={action === option.value}
											disabled={readOnly}
											onChange={() => setAction(option.value)}
											className="mt-1"
										/>
										<span>
											<span className="block text-sm font-medium text-text-primary">{option.label}</span>
											<span className="mt-0.5 block text-xs leading-4 text-muted">{option.description}</span>
										</span>
									</label>
								))}
							</div>

							{action === "update" && (
								<label className="mt-4 block">
									<span className="mb-1 block text-xs font-medium text-secondary">Choose the existing item</span>
									<select
										disabled={readOnly}
										value={existingItemId}
										onChange={(event) => setExistingItemId(event.target.value)}
										className="h-10 w-full rounded-md border border-border-input bg-canvas px-3 text-sm text-text-primary disabled:opacity-70"
									>
										<option value="">Select an inventory item…</option>
										{inventory.data?.map((item) => (
											<option key={item.id} value={item.id}>
												{item.name} · {item.sku ?? "No SKU"}
											</option>
										))}
									</select>
									{!existingItemId && <span className="mt-1 block text-xs text-warning-text">Choose an item before saving.</span>}
								</label>
							)}

							{candidate.existing_item && (
								<div className="mt-3 rounded-lg bg-canvas p-3 text-xs text-secondary">
									<p className="flex items-center gap-1 font-medium text-text-primary">
										<CheckCircle2 size={13} /> Suggested match
									</p>
									<p className="mt-2">{candidate.existing_item.name}</p>
									<p>SKU: {candidate.existing_item.sku ?? "None"}</p>
									<p>On hand: {candidate.existing_item.quantity} {candidate.existing_item.unit}</p>
									<p>Location: {candidate.existing_item.location}</p>
								</div>
							)}

							{candidate.duplicate_group && (
								<p className="mt-3 rounded-lg bg-warning-bg p-3 text-xs leading-4 text-warning-text">
									<Layers3 size={13} className="mr-1 inline" />
									This may be a duplicate. Compare it with the other matching rows before saving.
								</p>
							)}
							{candidate.variant_group_suggestion && (
								<label className="mt-3 flex items-start gap-2 rounded-lg bg-primary-bg p-3 text-xs leading-4 text-link">
									<input
										disabled={readOnly}
										type="checkbox"
										checked={variantApproved}
										onChange={(event) => setVariantApproved(event.target.checked)}
										className="mt-0.5"
									/>
									<span>
										<Layers3 size={13} className="mr-1 inline" />
										Group this with similar products as “{String(candidate.variant_group_suggestion.display_name ?? "suggested group")}.”
									</span>
								</label>
							)}
							{candidate.matching_evidence.photo_review_required === true && (
								<label className="mt-3 flex items-start gap-2 rounded-lg bg-primary-bg p-3 text-xs leading-4 text-link">
									<input
										disabled={readOnly}
										type="checkbox"
										checked={photoApproved}
										onChange={(event) => setPhotoApproved(event.target.checked)}
										className="mt-0.5"
									/>
									<span>
										<Image size={13} className="mr-1 inline" />
										Attach this source photo to the inventory item.
									</span>
								</label>
							)}
						</section>
					</div>

					{!readOnly && (
						<div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
							{patch.error && (
								<p className="mr-auto text-sm text-error-text" role="alert">{patch.error.message}</p>
							)}
							<button
								type="button"
								onClick={() => void save()}
								disabled={patch.isPending || (action === "update" && !existingItemId)}
								className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
							>
								<Save size={15} /> {patch.isPending ? "Saving…" : "Save item review"}
							</button>
						</div>
					)}
				</div>
			)}
		</article>
	);
}

export default function CandidateReviewTable({
	importId,
	candidates,
	readOnly = false,
}: {
	importId: string;
	candidates: InventoryImportCandidate[];
	readOnly?: boolean;
}) {
	if (candidates.length === 0) {
		return (
			<div className="rounded-xl border border-border bg-base p-10 text-center">
				<p className="font-medium text-text-primary">No items match these filters</p>
				<p className="mt-1 text-sm text-muted">Try a different search or show all item types.</p>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			{candidates.map((candidate) => (
				<CandidateCard key={candidate.id} importId={importId} candidate={candidate} readOnly={readOnly} />
			))}
		</div>
	);
}
