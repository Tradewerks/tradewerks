import { useState, useEffect, useMemo, useCallback } from "react";
import {
	type Invoice,
	type UpdateInvoiceInput,
	type UpdateInvoiceLineItemInput,
} from "../../types/invoices";
import { type LineItemType, type EditableLineItem } from "../../types/common";
import { useUpdateInvoiceMutation } from "../../hooks/useInvoices";
import DatePicker from "../ui/DatePicker";
import Dropdown from "../ui/Dropdown";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import FinancialSummary from "../ui/forms/FinancialSummary";
import { UndoButton } from "../ui/forms/UndoButton";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { isEditable } from "../../types/invoices";
import type { SourceJob } from "../ui/forms/LineItemCard";

type Step = 1 | 2 | 3;

const STEPS = [
	{ id: 1 as Step, label: "Details" },
	{ id: 2 as Step, label: "Line Items" },
	{ id: 3 as Step, label: "Finalize" },
];

const PAYMENT_TERM_OPTIONS = [
	{ label: "— None —", value: "" },
	{ label: "Due on Receipt", value: "0" },
	{ label: "Net 7", value: "7" },
	{ label: "Net 15", value: "15" },
	{ label: "Net 30", value: "30" },
	{ label: "Net 45", value: "45" },
	{ label: "Net 60", value: "60" },
	{ label: "Net 90", value: "90" },
];

const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";

interface EditInvoiceProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	invoice: Invoice;
}

const EditInvoice = ({ isModalOpen, setIsModalOpen, invoice }: EditInvoiceProps) => {
	const { mutateAsync: updateInvoice } = useUpdateInvoiceMutation();
	const [isLoading, setIsLoading] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	type FormFields = {
		memo: string;
		internalNotes: string;
	};

	const { updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			memo: "",
			internalNotes: "",
		});

	// Date fields — tracked manually since DatePicker returns Date | null
	const [issueDate, setIssueDate] = useState<Date | null>(null);
	const [dueDate, setDueDate] = useState<Date | null>(null);
	const [paymentTermsDays, setPaymentTermsDays] = useState<string>("");
	const [originalIssueDate, setOriginalIssueDate] = useState<Date | null>(null);
	const [originalDueDate, setOriginalDueDate] = useState<Date | null>(null);

	// ── Line items ────────────────────────────────────────────────────────
	const { data: taxGroups = [] } = useTaxGroups();
	const clientExempt = invoice.client?.is_tax_exempt ?? false;
	const taxEditable = isEditable(invoice.status);

	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		updateLineItemSource,
		undoLineItemSource,
		subtotal,
		setLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		originalLineItems,
		setLineItemInventoryItem,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
	} = useLineItems({ minItems: 0, mode: "edit" });

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const lineItemsForCalc = useMemo(
		() =>
			activeLineItems.map((item) => ({
				id: item.id,
				total: item.total,
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
			})),
		[activeLineItems]
	);

	// ── Financials ────────────────────────────────────────────────────────
	const {
		taxRate,
		setTaxRate,
		taxAmount,
		discountType,
		setDiscountType,
		discountValue,
		setDiscountValue,
		discountAmount,
		total,
		groupsSummary,
		totalTax,
		resolvedTaxRate,
		resolvedTaxAmount,
		resolvedTotal,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		setOriginals: setFinancialOriginals,
	} = useFinancialCalculations(subtotal, {
		initialTaxRate: invoice.tax_rate ? Number(invoice.tax_rate) * 100 : 0,
		initialDiscountType: invoice.discount_type || "amount",
		initialDiscountValue: invoice.discount_value ? Number(invoice.discount_value) : 0,
		taxGroups,
		lineItemsForCalc,
		clientExempt,
	});

	// ── Wizard ────────────────────────────────────────────────────────────
	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 3 as Step, initialStep: 1 as Step });

	// ── Seed on open ──────────────────────────────────────────────────────
	useEffect(() => {
		if (!isModalOpen || !invoice) return;

		setSubmitError(null);
		resetWizard();

		setOriginals({
			memo: invoice.memo ?? "",
			internalNotes: invoice.internal_notes ?? "",
		});

		// Dates
		const issDate = invoice.issue_date ? new Date(invoice.issue_date) : null;
		const duDate = invoice.due_date ? new Date(invoice.due_date) : null;
		const terms = invoice.payment_terms_days ? String(invoice.payment_terms_days) : "";
		setIssueDate(issDate);
		setDueDate(duDate);
		setPaymentTermsDays(terms);
		setOriginalIssueDate(issDate);
		setOriginalDueDate(duDate);

		// Line items — seed from existing invoice line items
		const initialLineItems: EditableLineItem[] = (invoice.line_items ?? []).map(
			(item) => ({
				id: crypto.randomUUID(),
				entity_line_item_id: item.id,
				name: item.name,
				description: item.description ?? "",
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				item_type: (item.item_type ?? "") as LineItemType | "",
				total: Number(item.total),
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
				inventory_item_id: item.inventory_item_id ?? null,
				source_job_id: item.source_job_id ?? null,
				source_visit_id: item.source_visit_id ?? null,
				isNew: false,
				isDeleted: false,
			})
		);
		setLineItems(initialLineItems);

		// Financials
		setFinancialOriginals(
			invoice.tax_rate ? Number(invoice.tax_rate) * 100 : 0,
			invoice.discount_type ?? "amount",
			invoice.discount_value ? Number(invoice.discount_value) : 0
		);
	}, [isModalOpen, invoice, resetWizard, setOriginals, setLineItems, setFinancialOriginals]);

	// ── Auto due date from payment terms ──────────────────────────────────
	useEffect(() => {
		if (paymentTermsDays === "") return;
		const days = parseInt(paymentTermsDays, 10);
		if (!isNaN(days)) {
			const base = issueDate ? new Date(issueDate) : new Date();
			base.setDate(base.getDate() + days);
			setDueDate(base);
		}
	}, [paymentTermsDays, issueDate]);

	// ── Source attribution — build from linked jobs/visits on the invoice ─
	// Invoices already have their linked jobs/visits; we expose them for the
	// attribution picker so existing line items can be re-attributed if needed.
	const sourceJobs = useMemo((): SourceJob[] => {
		if (!invoice.jobs && !invoice.visits) return [];

		const jobMap = new Map<
			string,
			{
				id: string;
				job_number: string;
				name: string;
				visits: SourceJob["visits"];
			}
		>();

		for (const ij of invoice.jobs ?? []) {
			if (!jobMap.has(ij.job_id)) {
				jobMap.set(ij.job_id, {
					id: ij.job_id,
					job_number: ij.job.job_number,
					name: ij.job.name,
					visits: [],
				});
			}
		}

		for (const iv of invoice.visits ?? []) {
			const parentJobId = iv.visit.job.id;
			if (!jobMap.has(parentJobId)) {
				jobMap.set(parentJobId, {
					id: parentJobId,
					job_number: iv.visit.job.job_number,
					name: iv.visit.job.name,
					visits: [],
				});
			}
			jobMap.get(parentJobId)!.visits.push({
				id: iv.visit_id,
				scheduled_start_at: iv.visit.scheduled_start_at,
				status: iv.visit.status,
			});
		}

		return Array.from(jobMap.values());
	}, [invoice.jobs, invoice.visits]);

	// ── Validation ────────────────────────────────────────────────────────
	const validateStep1 = useCallback((): boolean => true, []);

	const validateStep2 = useCallback((): boolean => {
		const meaningful = activeLineItems.filter(
			(item) => item.name.trim() !== "" || item.unit_price > 0
		);
		if (meaningful.length === 0) return true;
		return meaningful.every(
			(item) =>
				item.name.trim() &&
				Number(item.quantity) > 0 &&
				Number(item.unit_price) >= 0
		);
	}, [activeLineItems]);

	const validateStep = useCallback(
		(step: Step): boolean => {
			if (step === 1) return validateStep1();
			if (step === 2) return validateStep2();
			return true;
		},
		[validateStep1, validateStep2]
	);

	const canGoNext = validateStep(currentStep);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep <= currentStep) return true;
			for (let step = 1; step < targetStep; step++) {
				if (!validateStep(step as Step)) return false;
			}
			return true;
		},
		[currentStep, validateStep]
	);

	// ── Submit ────────────────────────────────────────────────────────────
	const invokeUpdate = async () => {
		if (isLoading) return;

		const preparedLineItems: UpdateInvoiceLineItemInput[] = activeLineItems
			.filter((li) => li.name.trim() !== "")
			.map((item, index) => {
				const li = item as EditableLineItem;
				return {
					id: li.entity_line_item_id,
					name: item.name.trim(),
					description: item.description?.trim() || undefined,
					quantity: Number(item.quantity),
					unit_price: Number(item.unit_price),
					total: item.total,
					item_type: (item.item_type || undefined) as
						| LineItemType
						| undefined,
					taxable: item.taxable,
					tax_group_id: item.tax_group_id ?? undefined,
					inventory_item_id: item.inventory_item_id ?? undefined,
					sort_order: index,
					source_job_id: item.source_job_id ?? undefined,
					source_visit_id: item.source_visit_id ?? undefined,
				};
			});



		const updates: UpdateInvoiceInput = {
			memo: getValue("memo").trim() || undefined,
			internal_notes: getValue("internalNotes").trim() || undefined,
			issue_date: issueDate ? issueDate.toISOString().split("T")[0] : undefined,
			due_date: dueDate ? dueDate.toISOString().split("T")[0] : null,
			payment_terms_days: paymentTermsDays
				? parseInt(paymentTermsDays, 10)
				: undefined,
			subtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			total: resolvedTotal,
			line_items: preparedLineItems,
		};

		setIsLoading(true);
		try {
			await updateInvoice({ id: invoice.id, updates });
			setSubmitError(null);
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to update invoice:", error);
			setSubmitError(errorMessage(error, "Failed to update invoice. Please try again."));
		} finally {
			setIsLoading(false);
		}
	};

	// ── Payment terms dropdown entries ────────────────────────────────────
	const paymentTermsEntries = useMemo(
		() => (
			<>
				{PAYMENT_TERM_OPTIONS.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</>
		),
		[]
	);

	// ── Step content ──────────────────────────────────────────────────────
	const stepContent = useMemo(() => {
		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						{/* Client + Issue Date — mirroring CreateInvoice layout */}
						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Client
								</label>
								<div className="border border-border px-2.5 h-[34px] flex items-center w-full rounded bg-surface/50 text-text-tertiary text-sm min-w-0 truncate">
									{invoice.client?.name ??
										"—"}
								</div>
								<p className="text-[10px] text-text-muted mt-0.5 leading-tight">
									Cannot be changed
								</p>
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Issue Date
								</label>
								<DatePicker
									portal
									mode="edit"
									originalValue={
										originalIssueDate
									}
									value={issueDate}
									onChange={(d) =>
										setIssueDate(d)
									}
									disabled={isLoading}
									align="right"
								/>
							</div>
						</div>

						{/* Memo */}
						<div className="min-w-0">
							<label className={LABEL}>
								Memo / Subject
							</label>
							<div className="relative">
								<input
									type="text"
									placeholder="e.g. April Service Invoice"
									value={getValue("memo")}
									onChange={(e) =>
										updateField(
											"memo",
											e.target
												.value
										)
									}
									className={INPUT}
									disabled={isLoading}
								/>
								<UndoButton
									show={isDirty("memo")}
									onUndo={() =>
										undoField("memo")
									}
									disabled={isLoading}
								/>
							</div>
						</div>

						{/* Payment Terms + Due Date */}
						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Payment Terms
								</label>
								<Dropdown
									entries={
										paymentTermsEntries
									}
									value={paymentTermsDays}
									onChange={(v) =>
										setPaymentTermsDays(
											v
										)
									}
									placeholder="— None —"
									disabled={isLoading}
								/>
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Due Date{" "}
									<span className="text-text-muted normal-case font-normal">
										(auto or override)
									</span>
								</label>
								<DatePicker
									portal
									mode="edit"
									originalValue={
										originalDueDate
									}
									value={dueDate}
									onChange={(d) => {
										setDueDate(d);
										setPaymentTermsDays(
											""
										);
									}}
									disabled={isLoading}
									align="right"
								/>
							</div>
						</div>

						{/* Internal Notes */}
						<div className="min-w-0">
							<label className={LABEL}>
								Internal Notes{" "}
								<span className="text-text-muted normal-case font-normal">
									(not shown to client)
								</span>
							</label>
							<div className="relative">
								<textarea
									placeholder="Internal notes for your team..."
									value={getValue(
										"internalNotes"
									)}
									onChange={(e) =>
										updateField(
											"internalNotes",
											e.target
												.value
										)
									}
									className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
									disabled={isLoading}
								/>
								<UndoButton
									show={isDirty(
										"internalNotes"
									)}
									onUndo={() =>
										undoField(
											"internalNotes"
										)
									}
									disabled={isLoading}
								/>
							</div>
						</div>

						{/* Linked jobs/visits — grouped by job, read-only */}
						{((invoice.jobs?.length ?? 0) > 0 ||
							(invoice.visits?.length ?? 0) > 0) && (
							<div className="min-w-0">
								<label className={LABEL}>
									Linked Jobs &amp; Visits{" "}
									<span className="text-text-muted normal-case font-normal">
										(read-only)
									</span>
								</label>
								<div className="space-y-1.5 mt-1">
									{sourceJobs.map((sj) => {
										// Find billed_amount for this job link if present
										const jobLink = (
											invoice.jobs ??
											[]
										).find(
											(ij) =>
												ij.job_id ===
												sj.id
										);
										return (
											<div
												key={
													sj.id
												}
												className="rounded-md border border-border bg-base overflow-hidden"
											>
												{/* Job row */}
												<div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
													<svg
														width="12"
														height="12"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														strokeWidth="2"
														className="text-text-muted flex-shrink-0"
													>
														<rect
															x="2"
															y="7"
															width="20"
															height="14"
															rx="2"
														/>
														<path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
													</svg>
													<span className="text-sm font-medium text-text-primary truncate flex-1">
														{
															sj.job_number
														}{" "}
														·{" "}
														{
															sj.name
														}
													</span>
													{jobLink?.billed_amount !==
														undefined &&
														jobLink.billed_amount !==
															null && (
															<span className="text-xs text-text-muted flex-shrink-0">
																billed{" "}
																{Number(
																	jobLink.billed_amount
																).toLocaleString(
																	"en-US",
																	{
																		style: "currency",
																		currency: "USD",
																	}
																)}
															</span>
														)}
												</div>
												{/* Visit rows indented under their job */}
												{sj.visits.map(
													(
														sv
													) => {
														const visitLink =
															(
																invoice.visits ??
																[]
															).find(
																(
																	iv
																) =>
																	iv.visit_id ===
																	sv.id
															);
														return (
															<div
																key={
																	sv.id
																}
																className="flex items-center gap-2 pl-7 pr-3 py-1.5 border-t border-border-subtle bg-surface/40"
															>
																<svg
																	width="11"
																	height="11"
																	viewBox="0 0 24 24"
																	fill="none"
																	stroke="currentColor"
																	strokeWidth="2"
																	className="text-text-muted flex-shrink-0"
																>
																	<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
																	<circle
																		cx="12"
																		cy="10"
																		r="3"
																	/>
																</svg>
																<span className="text-xs text-text-secondary flex-1">
																	{
																		sj.job_number
																	}{" "}
																	·
																	Visit{" "}
																	{new Date(
																		sv.scheduled_start_at
																	).toLocaleDateString(
																		"en-US",
																		{
																			month: "short",
																			day: "numeric",
																			year: "numeric",
																		}
																	)}
																</span>
																<span className="text-[10px] text-text-muted flex-shrink-0">
																	{
																		sv.status
																	}
																</span>
																{visitLink?.billed_amount !==
																	undefined &&
																	visitLink.billed_amount !==
																		null && (
																		<span className="text-[10px] text-text-muted flex-shrink-0 ml-1">
																			billed{" "}
																			{Number(
																				visitLink.billed_amount
																			).toLocaleString(
																				"en-US",
																				{
																					style: "currency",
																					currency: "USD",
																				}
																			)}
																		</span>
																	)}
															</div>
														);
													}
												)}
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>
				);

			case 2:
				return (
					<div className="min-w-0 flex flex-col -mt-3 sm:-mt-4">
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={addLineItem}
							onRemove={removeLineItem}
							onUpdate={updateLineItem}
							onUpdateSource={updateLineItemSource}
							subtotal={subtotal}
							required={false}
							minItems={0}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
							onUndoSource={undoLineItemSource}
							originalLineItemsMap={originalLineItems}
							sourceJobs={sourceJobs}
							stickyHeader
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={taxEditable ? setLineItemTaxGroup : undefined}
							onTaxGroupBulkSet={taxEditable ? setAllLineItemsTaxGroup : undefined}
						/>
					</div>
				);

			case 3:
				return (
					<div className="space-y-3 lg:space-y-5 xl:space-y-6 min-w-0">
						{/* Summary */}
						<div className="p-3 bg-surface/50 rounded-lg border border-border/50 text-sm space-y-1.5">
							<div className="flex justify-between items-center">
								<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
									Invoice
								</span>
								<span className="text-text-primary font-medium">
									{invoice.invoice_number}
								</span>
							</div>
							<div className="flex justify-between items-center">
								<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
									Client
								</span>
								<span className="text-text-primary">
									{invoice.client?.name ??
										"—"}
								</span>
							</div>
							{getValue("memo") && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Memo
									</span>
									<span className="text-text-primary truncate max-w-[60%] text-right">
										{getValue("memo")}
									</span>
								</div>
							)}
							{issueDate && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Issue Date
									</span>
									<span className="text-text-primary">
										{issueDate.toLocaleDateString(
											"en-US",
											{
												month: "short",
												day: "numeric",
												year: "numeric",
											}
										)}
									</span>
								</div>
							)}
							{dueDate && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Due Date
									</span>
									<span className="text-text-primary">
										{dueDate.toLocaleDateString(
											"en-US",
											{
												month: "short",
												day: "numeric",
												year: "numeric",
											}
										)}
									</span>
								</div>
							)}
						</div>

						<FinancialSummary
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							discountType={discountType}
							discountValue={discountValue}
							discountAmount={discountAmount}
							total={resolvedTotal}
							groupsSummary={groupsSummary}
							totalTax={totalTax}
							clientExempt={clientExempt}
							isLoading={isLoading}
							mode="edit"
							onTaxRateChange={groupsSummary.length > 0 ? undefined : setTaxRate}
							onDiscountTypeChange={setDiscountType}
							onDiscountValueChange={setDiscountValue}
							totalLabel="Invoice Total"
							isTaxDirty={isTaxDirty}
							isDiscountDirty={isDiscountDirty}
							onTaxUndo={undoTax}
							onDiscountUndo={undoDiscount}
						/>
					</div>
				);

			default:
				return null;
		}
	}, [
		currentStep,
		invoice,
		isLoading,
		getValue,
		updateField,
		undoField,
		isDirty,
		issueDate,
		dueDate,
		paymentTermsDays,
		originalIssueDate,
		originalDueDate,
		paymentTermsEntries,
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		updateLineItemSource,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		undoLineItemSource,
		originalLineItems,
		sourceJobs,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,
		groupsSummary,
		totalTax,
		taxEditable,
		taxGroups,
		clientExempt,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
	]);

	return (
		<FormWizardContainer<Step>
			title="Edit Invoice"
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={goToStep}
			onNext={goNext}
			onBack={goBack}
			onSubmit={invokeUpdate}
			canGoNext={canGoNext}
			submitLabel="Save Changes"
			isEditMode={true}
		>
			<>
				<FormErrorBanner message={submitError} className="mb-2" />
				{stepContent}
			</>
		</FormWizardContainer>
	);
};

export default EditInvoice;
