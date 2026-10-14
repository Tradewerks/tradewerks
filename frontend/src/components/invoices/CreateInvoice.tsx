import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { InvoiceStatusLabels, type InvoiceStatus, type CreateInvoiceInput, type CreateInvoiceLineItemInput } from "../../types/invoices";
import { type LineItemType, type BaseLineItem } from "../../types/common";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useAllJobsQuery } from "../../hooks/useJobs";
import { useCreateInvoiceMutation, useInvoicesByClientIdQuery, useOverlapCheckMutation } from "../../hooks/useInvoices";
import { useJobVisitsByJobIdQuery } from "../../hooks/useJobs";
import { getJobVisitById } from "../../api/jobs";
import type { OverlapWarning } from "../../types/invoices";
import Dropdown from "../ui/Dropdown";
import DatePicker from "../ui/DatePicker";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import FinancialSummary from "../ui/forms/FinancialSummary";
import { TemplateSearch, type TemplateSearchResult, type TemplateSearchClient } from "../ui/forms/TemplateSearch";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { useTaxGroups, useDefaultTaxGroup } from "../../hooks/useTaxGroups";
import { useQBStatusQuery, useImportableQBInvoicesQuery, useQBInvoicePrefillQuery } from "../../hooks/useQuickbooks";
import { Briefcase, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";

type Step = 1 | 2 | 3;

interface CreateInvoiceProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	defaultClientId?: string;
	initialVisitIds?: string[];
	initialJobId?: string;
}

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

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

// ── Billing history derived types ─────────────────────────────────────────
interface JobBillingInfo {
	totalInvoiced: number;
	invoiceCount: number;
	invoiceNumbers: string[];
}
interface VisitBillingInfo {
	totalInvoiced: number;
	invoiceNumbers: string[];
}

const CreateInvoice = ({ isModalOpen, setIsModalOpen, defaultClientId, initialVisitIds, initialJobId }: CreateInvoiceProps) => {
	// ── Core form state ───────────────────────────────────────────────────
	const [clientId, setClientId] = useState(defaultClientId ?? "");
	const [memo, setMemo] = useState("");
	const [internalNotes, setInternalNotes] = useState("");
	const [paymentTermsDays, setPaymentTermsDays] = useState<string>("");
	const [dueDate, setDueDate] = useState<Date | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [, setIsDirty] = useState(false);
	const [qbSearchOpen, setQbSearchOpen] = useState(false);
	const [selectedQBInvoice, setSelectedQBInvoice] = useState<string | null>(null);
	// Tracks whether a source picker or other inner input was recently focused,
	// so the next row click doesn't accidentally toggle selection.
	const billingInputFocusedRef = useRef(false);
	// Synchronous in-flight guard for handleImportFromVisits — prevents double-import
	// on rapid double-click before React re-renders the disabled button state.
	const importingFromVisitsRef = useRef(false);
	// Cache fetched visit data so re-imports hit memory, not the network
	const visitDataCacheRef = useRef<Map<string, Awaited<ReturnType<typeof getJobVisitById>>>>(new Map());

	// ── Job / visit picker state ──────────────────────────────────────────
	const [linkedJobIds, setLinkedJobIds] = useState<Set<string>>(new Set());
	const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
	const [visitBillings, setVisitBillings] = useState<Map<string, number>>(new Map());
	const [importedSources, setImportedSources] = useState<Set<string>>(new Set());

	// ── Overlap / import state ────────────────────────────────────────────
	const [overlapWarnings, setOverlapWarnings] = useState<OverlapWarning[]>([]);
	const [showOverlapModal, setShowOverlapModal] = useState(false);
	const [emptyVisitWarnings, setEmptyVisitWarnings] = useState<string[]>([]);
	const [importingLineItems, setImportingLineItems] = useState(false);
	const [isCheckingOverlap, setIsCheckingOverlap] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	// ── Queries ───────────────────────────────────────────────────────────
	const { data: clients } = useAllClientsQuery();
	const { data: allJobs = [] } = useAllJobsQuery();
	const { data: clientInvoices = [] } = useInvoicesByClientIdQuery(clientId);
	const { data: initialJobVisits = [] } = useJobVisitsByJobIdQuery(initialJobId ?? "");
	const { mutateAsync: insertInvoice } = useCreateInvoiceMutation();
	const { mutateAsync: checkOverlap } = useOverlapCheckMutation();
	const { data: taxGroups = [] } = useTaxGroups();
	const { data: defaultTaxGroup } = useDefaultTaxGroup();
	const qbConnected = !!useQBStatusQuery().data?.connected;
	const {
		data: importableQBInvoices = [],
		isFetching: qbInvoicesLoading,
	} = useImportableQBInvoicesQuery(qbConnected && qbSearchOpen, clientId);
	const { data: qbPrefill, isFetching: qbPrefillLoading } =
		useQBInvoicePrefillQuery(selectedQBInvoice);
	// Guards the prefill effect so editing the seeded form doesn't re-seed.
	const appliedPrefillRef = useRef<string | null>(null);
	const clientExempt = useMemo(
		() => clients?.find((c) => c.id === clientId)?.is_tax_exempt ?? false,
		[clients, clientId]
	);

	// ── Hooks ─────────────────────────────────────────────────────────────
	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		updateLineItemSource: hookUpdateLineItemSource,
		undoLineItemSource,
		subtotal,
		resetLineItems,
		seedLineItems,
		appendLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		originalLineItems,
		setLineItemInventoryItem,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
	} = useLineItems({ minItems: 0, mode: "create", defaultTaxGroupId: defaultTaxGroup?.id ?? null });

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
		reset: resetFinancials,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
	} = useFinancialCalculations(subtotal, { taxGroups, lineItemsForCalc, clientExempt });

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 3 as Step, initialStep: 1 as Step });

	const markDirty = useCallback(() => setIsDirty(true), []);

	// ── Derived: jobs for this client ─────────────────────────────────────
	const clientJobs = useMemo(() => {
		if (!clientId) return [];
		return allJobs.filter((j) => j.client_id === clientId && j.status !== "Cancelled");
	}, [allJobs, clientId]);

	// ── Derived: billing history maps from non-void invoices ──────────────
	const { jobBillingMap, visitBillingMap } = useMemo(() => {
		const jMap = new Map<string, JobBillingInfo>();
		const vMap = new Map<string, VisitBillingInfo>();

		for (const inv of clientInvoices) {
			if (inv.status === "Void") continue;

			for (const ij of inv.jobs ?? []) {
				if (ij.billed_amount === null || ij.billed_amount === undefined)
					continue;
				const existing = jMap.get(ij.job_id);
				if (existing) {
					existing.totalInvoiced += Number(ij.billed_amount);
					existing.invoiceCount += 1;
					existing.invoiceNumbers.push(inv.invoice_number);
				} else {
					jMap.set(ij.job_id, {
						totalInvoiced: Number(ij.billed_amount),
						invoiceCount: 1,
						invoiceNumbers: [inv.invoice_number],
					});
				}
			}

			for (const iv of inv.visits ?? []) {
				const existing = vMap.get(iv.visit_id);
				if (existing) {
					existing.totalInvoiced += Number(iv.billed_amount);
					existing.invoiceNumbers.push(inv.invoice_number);
				} else {
					vMap.set(iv.visit_id, {
						totalInvoiced: Number(iv.billed_amount),
						invoiceNumbers: [inv.invoice_number],
					});
				}
			}
		}

		return { jobBillingMap: jMap, visitBillingMap: vMap };
	}, [clientInvoices]);

	// ── Derived: which jobs/visits have importable line items ─────────────
	const importSources = useMemo(() => {
		const sources: { id: string; label: string; items: unknown[] }[] = [];

		for (const jobId of linkedJobIds) {
			const job = clientJobs.find((j) => j.id === jobId);
			if (!job) continue;
			const items = job.line_items ?? [];
			if (items.length > 0 && !importedSources.has(jobId)) {
				sources.push({ id: jobId, label: `${job.job_number}`, items });
			}
		}

		for (const [visitId] of visitBillings) {
			const job = clientJobs.find((j) =>
				(j.visits ?? []).some((v) => v.id === visitId)
			);
			if (!job) continue;
			const visit = (job.visits ?? []).find(
				(v) => v.id === visitId
			);
			if (!visit) continue;
			const items = visit.line_items ?? [];
			if (items.length > 0 && !importedSources.has(visitId)) {
				sources.push({
					id: visitId,
					label: `Visit ${new Date(visit.scheduled_start_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
					items,
				});
			}
		}

		return sources;
	}, [linkedJobIds, visitBillings, clientJobs, importedSources]);

	// ── Auto due date ──────────────────────────────────────────────────────
	useEffect(() => {
		if (paymentTermsDays === "") return;
		const days = parseInt(paymentTermsDays, 10);
		if (!isNaN(days)) {
			const base = new Date();
			base.setDate(base.getDate() + days);
			setDueDate(base);
		}
	}, [paymentTermsDays]);

	// ── Auto-fill from a selected QuickBooks invoice ────────────────────────
	// Seeds line items + memo + due date once per selected invoice. Client stays
	// as the user picked it (org-wide list lets you assign to any client).
	useEffect(() => {
		if (!qbPrefill) return;
		if (appliedPrefillRef.current === qbPrefill.qbInvoiceId) return;
		appliedPrefillRef.current = qbPrefill.qbInvoiceId;

		seedLineItems(
			qbPrefill.lineItems.map((li) => ({
				name: li.name,
				description: li.description ?? "",
				quantity: li.quantity,
				unit_price: li.unit_price,
				item_type: "",
			})),
		);
		setMemo(qbPrefill.memo ?? "");
		setDueDate(qbPrefill.dueDate ? new Date(qbPrefill.dueDate) : null);
		// If the QB customer maps to a local client, adopt it (like draft import).
		if (qbPrefill.clientId) setClientId(qbPrefill.clientId);
		markDirty();
	}, [qbPrefill, seedLineItems, markDirty]);

	// ── Reset ──────────────────────────────────────────────────────────────
	const resetForm = useCallback(() => {
		resetWizard();
		setClientId(defaultClientId ?? "");
		setMemo("");
		setInternalNotes("");
		setPaymentTermsDays("");
		setDueDate(null);
		setLinkedJobIds(new Set());
		setExpandedJobs(new Set());
		setVisitBillings(new Map());
		setImportedSources(new Set());
		setQbSearchOpen(false);
		setSelectedQBInvoice(null);
		appliedPrefillRef.current = null;
		resetLineItems();
		resetFinancials();
		setIsDirty(false);
		setSubmitError(null);
	}, [resetWizard, resetLineItems, resetFinancials, defaultClientId]);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	// ── Pre-select visits from context entry points ───────────────────────
	useEffect(() => {
		if (!isModalOpen) return;
		if (initialVisitIds && initialVisitIds.length > 0) {
			// Pre-select specific visits with actual totals when available
			const billings = new Map(
				initialVisitIds.map((id) => {
					const matched = initialJobVisits.find((v) => v.id === id);
					return [id, matched ? Number(matched.total ?? 0) : 0];
				}),
			);
			setVisitBillings(billings);
			// Link and expand the parent job so the pre-selected visit is visible in the picker
			if (initialJobId) {
				setLinkedJobIds(new Set([initialJobId]));
				setExpandedJobs(new Set([initialJobId]));
			}
		} else if (initialJobId && initialJobVisits.length > 0) {
			const completedVisits = initialJobVisits.filter((v) => v.status === "Completed");
			if (completedVisits.length > 0) {
				setLinkedJobIds(new Set([initialJobId]));
				setExpandedJobs(new Set([initialJobId]));
				setVisitBillings(
					new Map(completedVisits.map((v) => [v.id, Number(v.total ?? 0)])),
				);
			}
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isModalOpen, initialJobId, initialJobVisits.length]);

	// ── Job picker handlers ───────────────────────────────────────────────
	const toggleJobExpanded = useCallback((jobId: string) => {
		setExpandedJobs((prev) => {
			const next = new Set(prev);
			if (next.has(jobId)) next.delete(jobId);
			else next.add(jobId);
			return next;
		});
	}, []);

	const toggleJobLinked = useCallback(
		(jobId: string) => {
			const job = clientJobs.find((j) => j.id === jobId);
			if (!job) return;

			setLinkedJobIds((prev) => {
				const next = new Set(prev);
				if (next.has(jobId)) {
					next.delete(jobId);
					setVisitBillings((vPrev) => {
						const vNext = new Map(vPrev);
						for (const visit of job.visits ?? []) {
							vNext.delete(visit.id);
						}
						return vNext;
					});
					setExpandedJobs((ePrev) => {
						const eNext = new Set(ePrev);
						eNext.delete(jobId);
						return eNext;
					});
				} else {
					next.add(jobId);
					setExpandedJobs((ePrev) => new Set([...ePrev, jobId]));

					setVisitBillings((vPrev) => {
						const vNext = new Map(vPrev);
						for (const visit of job.visits ?? []) {
							if (
								visit.status === "Completed" &&
								!visitBillingMap.has(visit.id)
							) {
								vNext.set(
									visit.id,
									Number(visit.total ?? 0)
								);
							}
						}
						return vNext;
					});
				}
				return next;
			});
			markDirty();
		},
		[clientJobs, visitBillingMap, markDirty]
	);

	const toggleVisitSelected = useCallback(
		(visitId: string, visitTotal: number) => {
			if (billingInputFocusedRef.current) {
				billingInputFocusedRef.current = false;
				return;
			}
			setVisitBillings((prev) => {
				const next = new Map(prev);
				if (next.has(visitId)) {
					next.delete(visitId);
				} else {
					next.set(visitId, visitTotal);
					const parentJob = clientJobs.find((j) =>
						(j.visits ?? []).some(
							(v) => v.id === visitId
						)
					);
					if (parentJob) {
						setLinkedJobIds((jPrev) => {
							if (jPrev.has(parentJob.id)) return jPrev;
							return new Set([...jPrev, parentJob.id]);
						});
					}
				}
				return next;
			});
			markDirty();
		},
		[clientJobs, markDirty]
	);

	// Pick a QB invoice from the search overlay → close search, prefill effect seeds the form
	const handleSelectQBInvoice = useCallback((qbInvoiceId: string) => {
		setSelectedQBInvoice(qbInvoiceId);
		setQbSearchOpen(false);
	}, []);

	// ── Import all (jobs + visits) ────────────────────────────────────────
	const handleImportAll = useCallback(async () => {
		if (importingFromVisitsRef.current) return;
		importingFromVisitsRef.current = true;
		setImportingLineItems(true);
		setEmptyVisitWarnings([]);
		try {
			const seeds: Parameters<typeof appendLineItems>[0] = [];
			const newImportedJobIds: string[] = [];

			// Job-level line items (from already-loaded local data)
			for (const jobId of linkedJobIds) {
				if (importedSources.has(jobId)) continue;
				const job = clientJobs.find((j) => j.id === jobId);
				if (!job || !job.line_items?.length) continue;
				for (const item of job.line_items) {
					seeds.push({
						name: item.name ?? "",
						description: item.description ?? "",
						quantity: Number(item.quantity ?? 1),
						unit_price: Number(item.unit_price ?? 0),
						item_type: item.item_type ?? "",
						inventory_item_id: item.inventory_item_id ?? null,
						source_job_id: jobId,
						source_visit_id: null,
					});
				}
				newImportedJobIds.push(jobId);
			}

			// Visit line items (API fetch with cache; smart restore on re-click)
			if (visitBillings.size > 0) {
				const allVisitIds = [...visitBillings.keys()];
				const uncachedIds = allVisitIds.filter((id) => !visitDataCacheRef.current.has(id));
				if (uncachedIds.length > 0) {
					const fetched = await Promise.all(uncachedIds.map((id) => getJobVisitById(id)));
					fetched.forEach((v) => visitDataCacheRef.current.set(v.id, v));
				}
				const empty: string[] = [];
				for (const visitId of allVisitIds) {
					const visit = visitDataCacheRef.current.get(visitId)!;
					if (!visit.line_items?.length) {
						const dateLabel = new Date(visit.scheduled_start_at).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
						});
						empty.push(`${dateLabel} (#${visit.id.slice(0, 6)})`);
						continue;
					}
					// Only add items not already present for this visit (restore-on-re-click)
					const existingNames = new Set(
						activeLineItems
							.filter((li) => li.source_visit_id === visitId)
							.map((li) => li.name)
					);
					for (const li of visit.line_items) {
						if (existingNames.has(li.name)) continue;
						seeds.push({
							name: li.name,
							description: li.description ?? "",
							quantity: Number(li.quantity),
							unit_price: Number(li.unit_price),
							item_type: li.item_type ?? "",
							// The visit is where the link is real — a tech
							// scanned or picked this part. Dropping it here was
							// severing the only populated link in the system.
							inventory_item_id: li.inventory_item_id ?? null,
							source_visit_id: visit.id,
							source_job_id: visit.job?.id ?? null,
						});
					}
				}
				setEmptyVisitWarnings(empty);
			}

			if (seeds.length > 0) {
				appendLineItems(seeds);
				markDirty();
			}
			if (newImportedJobIds.length > 0) {
				setImportedSources((prev) => new Set([...prev, ...newImportedJobIds]));
			}
		} finally {
			importingFromVisitsRef.current = false;
			setImportingLineItems(false);
		}
	}, [visitBillings, linkedJobIds, clientJobs, importedSources, activeLineItems, appendLineItems, markDirty]);

	// ── Validation ────────────────────────────────────────────────────────
	const validateStep1 = useCallback((): boolean => !!clientId.trim(), [clientId]);

	const validateStep2 = useCallback((): boolean => {
		const meaningful = activeLineItems.filter((item) => {
			const hasText =
				item.name.trim() !== "" || (item.description?.trim() ?? "") !== "";
			const hasNumbers = Number(item.unit_price) > 0;
			const hasType = (item.item_type?.trim?.() ?? "") !== "";
			return hasText || hasNumbers || hasType;
		});
		if (meaningful.length === 0) return false;
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

	// ── Step 1→2 transition: run overlap check ────────────────────────────
	const handleNext = useCallback(async () => {
		if (currentStep === 1 && visitBillings.size > 0) {
			setIsCheckingOverlap(true);
			try {
				const { warnings } = await checkOverlap([...visitBillings.keys()]);
				if (warnings.length > 0) {
					setOverlapWarnings(warnings);
					setShowOverlapModal(true);
					return;
				}
			} catch {
				// Non-blocking — proceed even if overlap check fails
			} finally {
				setIsCheckingOverlap(false);
			}
		}
		goNext();
	}, [currentStep, visitBillings, checkOverlap, goNext]);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep === currentStep) return true;
			if (visitedSteps.has(targetStep)) return true;
			if (targetStep === currentStep + 1 && validateStep(currentStep))
				return true;
			return false;
		},
		[currentStep, visitedSteps, validateStep]
	);


	// ── Dirty wrappers ────────────────────────────────────────────────────
	const dirtyAddLineItem = useCallback(() => {
		addLineItem();
		markDirty();
	}, [addLineItem, markDirty]);

	const dirtyRemoveLineItem = useCallback(
		(id: string) => {
			removeLineItem(id);
			markDirty();
		},
		[removeLineItem, markDirty]
	);

	const dirtyUpdateLineItem = useCallback(
		(id: string, field: keyof BaseLineItem, value: string | number) => {
			updateLineItem(id, field, value);
			markDirty();
		},
		[updateLineItem, markDirty]
	);

	const updateLineItemSource = useCallback(
		(id: string, sourceJobId: string | null, sourceVisitId: string | null) => {
			hookUpdateLineItemSource(id, sourceJobId, sourceVisitId);
			markDirty();
		},
		[hookUpdateLineItemSource, markDirty]
	);

	// ── Submit ────────────────────────────────────────────────────────────
	const invokeCreate = async () => {
		if (isLoading) return;
		if (!clientId.trim()) return;

		const preparedLineItems: CreateInvoiceLineItemInput[] = activeLineItems
			.filter((li) => li.name.trim() !== "" && li.quantity > 0)
			.map((item) => ({
				name: item.name,
				description: item.description || undefined,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				total: item.total,
				item_type: (item.item_type || undefined) as
					| LineItemType
					| undefined,
				taxable: item.taxable,
				tax_group_id: item.tax_group_id ?? undefined,
				inventory_item_id: item.inventory_item_id ?? undefined,
				source_job_id: item.source_job_id ?? undefined,
				source_visit_id: item.source_visit_id ?? undefined,
			}));

		const safeSubtotal = isNaN(subtotal) ? 0 : subtotal;
		const safeDiscountValue = isNaN(discountValue ?? 0) ? 0 : (discountValue ?? 0);
		const safeDiscountAmount = isNaN(discountAmount ?? 0) ? 0 : (discountAmount ?? 0);

		const visitBilledAmounts = new Map<string, number>();
		for (const [visitId] of visitBillings) {
			const total = preparedLineItems
				.filter((li) => li.source_visit_id === visitId)
				.reduce((sum, li) => sum + (li.total ?? 0), 0);
			visitBilledAmounts.set(visitId, total);
		}

		const preparedVisitBillings = Array.from(visitBillings.keys()).map((visit_id) => ({
			visit_id,
			billed_amount: visitBilledAmounts.get(visit_id) ?? 0,
		}));

		const preparedJobBillings = Array.from(linkedJobIds).map((job_id) => {
			const jobOnlyTotal = preparedLineItems
				.filter(
					(li) =>
						li.source_job_id === job_id &&
						!li.source_visit_id
				)
				.reduce((sum, li) => sum + (li.total ?? 0), 0);
			return { job_id, billed_amount: jobOnlyTotal };
		});

		const newInvoice: CreateInvoiceInput = {
			client_id: clientId.trim(),
			memo: memo.trim() || undefined,
			internal_notes: internalNotes.trim() || undefined,
			payment_terms_days: paymentTermsDays
				? parseInt(paymentTermsDays, 10)
				: undefined,
			due_date: dueDate ? dueDate.toISOString().split("T")[0] : undefined,
			job_billings:
				preparedJobBillings.length > 0 ? preparedJobBillings : undefined,
			visit_billings:
				preparedVisitBillings.length > 0
					? preparedVisitBillings
					: undefined,
			subtotal: safeSubtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: safeDiscountValue,
			discount_amount: safeDiscountAmount,
			total: resolvedTotal,
			line_items: preparedLineItems.length ? preparedLineItems : undefined,
		};

		setIsLoading(true);
		setSubmitError(null);
		try {
			await insertInvoice(newInvoice);
			setIsModalOpen(false);
			resetForm();
		} catch (error) {
			setSubmitError(errorMessage(error, "Failed to create invoice. Please try again."));
		} finally {
			setIsLoading(false);
		}
	};

	// ── Dropdown entries ──────────────────────────────────────────────────
	const clientDropdownEntries = useMemo(() => {
		if (clients?.length) {
			return clients.map((c) => (
				<option value={c.id} key={c.id}>
					{c.name}
				</option>
			));
		}
		return (
			<option disabled value="">
				No clients found
			</option>
		);
	}, [clients]);

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

	// ── Visit status helpers ───────────────────────────────────────────────
	const getVisitStatusClass = (status: string) => {
		switch (status) {
			case "Completed":
				return "bg-success/10 text-success-text";
			case "InProgress":
			case "Driving":
			case "OnSite":
				return "bg-primary/10 text-primary-text";
			case "Paused":
			case "Delayed":
				return "bg-warning/10 text-warning-text";
			default:
				return "bg-surface-raised text-text-tertiary";
		}
	};

	const formatVisitDate = (dateStr: string | Date) => {
		return new Date(dateStr).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	const formatCurrency = (n: number) =>
		n.toLocaleString("en-US", { style: "currency", currency: "USD" });

	const formatInvoiceNums = (nums: string[], max = 2) => {
		if (nums.length <= max) return nums.join(", ");
		return `${nums.slice(0, max).join(", ")} +${nums.length - max} more`;
	};

	// ── QB invoice import: search-overlay data ──────────────────────────────
	const qbInvoiceResults = useMemo<TemplateSearchResult[]>(
		() =>
			importableQBInvoices.map((inv) => ({
				id: inv.Id,
				title: inv.customerName || `Invoice ${inv.DocNumber ?? inv.Id}`,
				subtitle: inv.DocNumber ? `#${inv.DocNumber}` : undefined,
				detail: `${inv.lineCount} line item${inv.lineCount === 1 ? "" : "s"}`,
				value: formatCurrency(inv.TotalAmt),
				createdAt: inv.TxnDate ?? undefined,
				clientId: inv.customerId ?? undefined,
				clientName: inv.customerName ?? undefined,
				// Informational only — a local invoice already exists for this QB
				// invoice. Still selectable: prefill is non-destructive (it only
				// pre-fills the form; saving creates a fresh, unlinked draft), so
				// re-importing to base a new draft on it is a valid use.
				badge: inv.alreadyImported ? "Imported" : undefined,
				badgeColor: inv.alreadyImported
					? "bg-success-bg text-success-text border-success-border"
					: undefined,
			})),
		[importableQBInvoices]
	);

	// QB customers present in the results — powers the "filter by customer" control
	const qbInvoiceClients = useMemo<TemplateSearchClient[]>(() => {
		const map = new Map<string, string>();
		importableQBInvoices.forEach((inv) => {
			if (inv.customerId && inv.customerName) map.set(inv.customerId, inv.customerName);
		});
		return [...map].map(([id, name]) => ({ id, name }));
	}, [importableQBInvoices]);

	// Label for the chip shown once an invoice has been imported
	const selectedQBLabel = useMemo(() => {
		if (!selectedQBInvoice) return null;
		const inv = importableQBInvoices.find((i) => i.Id === selectedQBInvoice);
		if (inv?.DocNumber) return `#${inv.DocNumber}`;
		if (qbPrefill?.docNumber) return `#${qbPrefill.docNumber}`;
		return "selected invoice";
	}, [selectedQBInvoice, importableQBInvoices, qbPrefill]);

	// ── Step content ──────────────────────────────────────────────────────
	const stepContent = useMemo(() => {
		// QuickBooks invoice import — full-height searchable card list (same UX as
		// the "Use Draft / Existing" search in CreateJob).
		if (qbSearchOpen) {
			return (
				<TemplateSearch
					heading="Import from QuickBooks"
					placeholder="Search by invoice #, customer…"
					results={qbInvoiceResults}
					clients={qbInvoiceClients}
					isLoading={qbInvoicesLoading}
					onSelect={handleSelectQBInvoice}
					onClose={() => setQbSearchOpen(false)}
				/>
			);
		}

		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						{/* Imported-from-QuickBooks chip */}
						{selectedQBInvoice && (
							<div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
								<span className="text-primary-text font-medium">
									{qbPrefillLoading
										? "Loading invoice details…"
										: `Imported from QuickBooks: ${selectedQBLabel}`}
								</span>
								<div className="ml-auto flex items-center gap-3">
									{qbConnected && (
										<button
											type="button"
											onClick={() => setQbSearchOpen(true)}
											disabled={isLoading}
											className="text-xs font-medium text-primary-text underline hover:text-text-primary disabled:opacity-40"
										>
											Change
										</button>
									)}
									<button
										type="button"
										onClick={() => {
											// Detach the QB import and clear what it prefilled.
											setSelectedQBInvoice(null);
											appliedPrefillRef.current = null;
											resetLineItems();
											setMemo("");
											setDueDate(null);
											markDirty();
										}}
										disabled={isLoading}
										className="text-xs font-medium text-text-tertiary underline hover:text-text-primary disabled:opacity-40"
									>
										Clear
									</button>
								</div>
							</div>
						)}

						{/* Client */}
						<div className="min-w-0">
							<label className={LABEL}>
								Client *
							</label>
							<Dropdown
								entries={clientDropdownEntries}
								value={clientId}
								onChange={(v) => {
									setClientId(v);
									setLinkedJobIds(new Set());
									setExpandedJobs(new Set());
									setVisitBillings(new Map());
									markDirty();
								}}
								placeholder="Select client"
								disabled={isLoading || !!defaultClientId}
							/>
						</div>

						{/* Memo */}
						<div className="min-w-0">
							<label className={LABEL}>
								Memo / Subject
							</label>
							<input
								type="text"
								placeholder="e.g. April Service Invoice"
								value={memo}
								onChange={(e) => {
									setMemo(e.target.value);
									markDirty();
								}}
								className={INPUT}
								disabled={isLoading}
							/>
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
									onChange={(v) => {
										setPaymentTermsDays(
											v
										);
										markDirty();
									}}
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
									value={dueDate}
									onChange={(d) => {
										setDueDate(d);
										setPaymentTermsDays(
											""
										);
										markDirty();
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
							<textarea
								placeholder="Internal notes for your team..."
								value={internalNotes}
								onChange={(e) => {
									setInternalNotes(
										e.target.value
									);
									markDirty();
								}}
								className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
								disabled={isLoading}
							/>
						</div>

						{/* ── Job / Visit Picker ─────────────────────────── */}
						{clientJobs.length > 0 && (
							<div className="min-w-0">
								<label className={LABEL}>
									Link Jobs &amp; Visits{" "}
									<span className="text-text-muted normal-case font-normal">
										(optional)
									</span>
								</label>

								<div className="space-y-1.5 mt-1">
									{clientJobs.map((job) => {
										const isJobLinked =
											linkedJobIds.has(
												job.id
											);
										const isExpanded =
											expandedJobs.has(
												job.id
											);
										const jobHistory =
											jobBillingMap.get(
												job.id
											);
										const visits =
											job.visits ??
											[];
										const linkedVisitCount =
											visits.filter(
												(v) =>
													visitBillings.has(
														v.id
													)
											).length;
										const hasAnyLink =
											isJobLinked ||
											linkedVisitCount >
												0;

										return (
											<div
												key={
													job.id
												}
												className="min-w-0"
											>
												{/* ── Job Row ── */}
												<div
													className={`flex items-center gap-0 rounded-md border transition-colors ${
														isJobLinked
															? "border-primary bg-primary/10"
															: "border-border bg-base hover:border-border-strong"
													}`}
												>
													{/* Checkbox area */}
													<button
														type="button"
														onClick={() =>
															toggleJobLinked(
																job.id
															)
														}
														disabled={
															isLoading
														}
														className="flex items-start gap-2 flex-1 min-w-0 px-3 py-2 text-left"
													>
														<div
															className={`w-3.5 h-3.5 rounded border flex-shrink-0 self-center flex items-center justify-center transition-colors ${
																isJobLinked
																	? "border-primary bg-primary"
																	: linkedVisitCount >
																		  0
																		? "border-primary-text bg-transparent"
																		: "border-border-strong bg-transparent"
															}`}
														>
															{isJobLinked && (
																<svg
																	width="8"
																	height="6"
																	viewBox="0 0 8 6"
																	fill="none"
																>
																	<path
																		d="M1 3L3 5L7 1"
																		stroke="currentColor"
																		strokeWidth="1.5"
																		strokeLinecap="round"
																		strokeLinejoin="round"
																	/>
																</svg>
															)}
															{!isJobLinked &&
																linkedVisitCount >
																	0 && (
																	<div className="w-1.5 h-1.5 rounded-full bg-primary-text" />
																)}
														</div>
														<Briefcase
															size={
																13
															}
															className={
																hasAnyLink
																	? "text-primary-text flex-shrink-0 self-center"
																	: "text-text-muted flex-shrink-0 self-center"
															}
														/>
														<div className="flex-1 min-w-0">
															<span className="block truncate text-sm font-medium text-text-primary">
																{
																	job.job_number
																}{" "}
																·{" "}
																{
																	job.name
																}
															</span>
															{jobHistory && (
																<div className="flex items-center gap-1 mt-0.5 text-[10px] text-warning-text/90">
																	<AlertTriangle
																		size={
																			9
																		}
																		className="flex-shrink-0"
																	/>
																	<span className="truncate">
																		Previously
																		billed{" "}
																		{formatCurrency(
																			jobHistory.totalInvoiced
																		)}{" "}
																		·{" "}
																		{formatInvoiceNums(
																			jobHistory.invoiceNumbers
																		)}
																	</span>
																</div>
															)}
														</div>
														<span
															className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 self-center ${
																job.status ===
																"Completed"
																	? "bg-success/10 text-success-text"
																	: job.status ===
																		  "InProgress"
																		? "bg-primary/10 text-primary-text"
																		: "bg-surface-raised text-text-tertiary"
															}`}
														>
															{
																job.status
															}
														</span>
													</button>

													{/* Visit count pill */}
													{!isExpanded &&
														linkedVisitCount >
															0 && (
															<span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 bg-primary/20 text-primary-text border border-primary/30 self-center mr-1">
																{
																	linkedVisitCount
																}{" "}
																visit
																{linkedVisitCount !==
																1
																	? "s"
																	: ""}{" "}
																linked
															</span>
														)}

													{/* Chevron toggle */}
													{visits.length >
														0 && (
														<button
															type="button"
															onClick={() =>
																toggleJobExpanded(
																	job.id
																)
															}
															disabled={
																isLoading
															}
															className={`px-3 py-2 transition-colors flex-shrink-0 border-l-2 ${
																hasAnyLink
																	? isExpanded
																		? "border-primary text-primary-text hover:text-text-primary bg-primary/5"
																		: "border-primary/50 text-primary-text hover:text-text-primary"
																	: "border-border-strong text-text-tertiary hover:text-text-primary hover:border-text-tertiary"
															}`}
															title={
																isExpanded
																	? "Collapse visits"
																	: "Expand visits"
															}
														>
															{isExpanded ? (
																<ChevronDown
																	size={
																		14
																	}
																/>
															) : (
																<ChevronRight
																	size={
																		14
																	}
																/>
															)}
														</button>
													)}
												</div>

												{/* ── Visit Sub-rows ── */}
												{isExpanded && (
													<div className="ml-4 mt-1 space-y-1">
														{visits.length ===
														0 ? (
															<p className="text-xs text-text-muted px-3 py-2">
																No
																visits
															</p>
														) : (
															visits.map(
																(
																	visit
																) => {
																	const isVisitSelected =
																		visitBillings.has(
																			visit.id
																		);
																	const visitHistory =
																		visitBillingMap.get(
																			visit.id
																		);

																	return (
																		<div
																			key={
																				visit.id
																			}
																			className="min-w-0"
																		>
																			<button
																				type="button"
																				onClick={() =>
																					toggleVisitSelected(
																						visit.id,
																						Number(
																							visit.total ??
																								0
																						)
																					)
																				}
																				disabled={
																					isLoading
																				}
																				className={`w-full flex items-center gap-2 px-3 py-1.5 rounded border transition-colors text-sm text-left ${
																					isVisitSelected
																						? "border-primary/50 bg-primary/5"
																						: "border-border/50 bg-surface/50 hover:border-border-strong"
																				}`}
																			>
																				{/* Checkbox */}
																				<div
																					className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
																						isVisitSelected
																							? "border-primary bg-primary"
																							: "border-border-strong bg-transparent"
																					}`}
																				>
																					{isVisitSelected && (
																						<svg
																							width="8"
																							height="6"
																							viewBox="0 0 8 6"
																							fill="none"
																						>
																							<path
																								d="M1 3L3 5L7 1"
																								stroke="currentColor"
																								strokeWidth="1.5"
																								strokeLinecap="round"
																								strokeLinejoin="round"
																							/>
																						</svg>
																					)}
																				</div>

																				{/*
																				 * Layout: [date] [billing — fills gap, truncates] [status badge]
																				 * date:    flex-shrink-0 — never compresses
																				 * billing: flex-1 min-w-0 truncate — fills available space, truncates when tight
																				 * status:  flex-shrink-0 — always visible, pinned right
																				 */}
																				<span className="flex-shrink-0 text-sm text-text-secondary">
																					{formatVisitDate(
																						visit.scheduled_start_at
																					)}
																				</span>
																				{visitHistory && (
																					<span className="flex-1 min-w-0 truncate text-[10px] text-warning-text/90">
																						Previously
																						billed{" "}
																						{formatCurrency(
																							visitHistory.totalInvoiced
																						)}{" "}
																						·{" "}
																						{formatInvoiceNums(
																							visitHistory.invoiceNumbers
																						)}
																					</span>
																				)}
																				{!visitHistory && (
																					<span className="flex-1" />
																				)}
																				<span
																					className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${getVisitStatusClass(visit.status)}`}
																				>
																					{
																						visit.status
																					}
																				</span>
																			</button>
																		</div>
																	);
																}
															)
														)}
													</div>
												)}
											</div>
										);
									})}
								</div>

								{/* Summary line */}
								{(linkedJobIds.size > 0 ||
									visitBillings.size > 0) && (
									<div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
										{linkedJobIds.size >
											0 && (
											<span>
												{
													linkedJobIds.size
												}{" "}
												job
												{linkedJobIds.size !==
												1
													? "s"
													: ""}{" "}
												linked
											</span>
										)}
										{visitBillings.size >
											0 && (
											<>
												<span className="text-text-faint">
													·
												</span>
												<span>
													{
														visitBillings.size
													}{" "}
													visit
													{visitBillings.size !==
													1
														? "s"
														: ""}{" "}
													selected
												</span>
											</>
										)}
									</div>
								)}
							</div>
						)}
					</div>
				);

			case 2: {
				const sourceJobsForStep2 = clientJobs
					.filter((job) => linkedJobIds.has(job.id))
					.map((job) => ({
						id: job.id,
						job_number: job.job_number,
						name: job.name,
						visits: (job.visits ?? [])
							.filter((v) => visitBillings.has(v.id))
							.map((v) => ({
								id: v.id,
								scheduled_start_at:
									v.scheduled_start_at,
								status: v.status,
							})),
					}));

				const importableCount = Array.from(visitBillings.keys())
					.filter((visitId) => !importedSources.has(visitId))
					.reduce((n, visitId) => {
						for (const job of clientJobs) {
							const visit = (
								job.visits ?? []
							).find((v) => v.id === visitId);
							if (visit)
								return (
									n +
									(visit.line_items?.length ??
										0)
								);
						}
						return n;
					}, 0);

				const jobImportableCount = Array.from(linkedJobIds)
					.filter((jobId) => !importedSources.has(jobId))
					.reduce((n, jobId) => {
						const job = clientJobs.find((j) => j.id === jobId);
						return n + (job?.line_items?.length ?? 0);
					}, 0);

				const totalImportable = importableCount + jobImportableCount;

				const hasImportSource = visitBillings.size > 0 || totalImportable > 0;
				const importLabel = totalImportable > 0
					? `Import ${totalImportable} item${totalImportable !== 1 ? "s" : ""}`
					: visitBillings.size > 0
						? "Import from visits"
						: undefined;

				return (
					<div className="min-w-0 flex flex-col -mt-3 sm:-mt-4">
						{emptyVisitWarnings.length > 0 && (
							<div className="mb-2 mx-4 sm:mx-6 mt-3 rounded border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
								{emptyVisitWarnings.length === 1
									? `Visit on ${emptyVisitWarnings[0]} has no line items — add manually or deselect it.`
									: `${emptyVisitWarnings.length} visits have no line items (${emptyVisitWarnings.join(", ")}) — add manually or deselect them.`}
							</div>
						)}
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={dirtyAddLineItem}
							onRemove={dirtyRemoveLineItem}
							onUpdate={dirtyUpdateLineItem}
							onUpdateSource={updateLineItemSource}
							subtotal={subtotal}
							required={false}
							minItems={0}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
							onUndoSource={undoLineItemSource}
							originalLineItemsMap={originalLineItems}
							sourceJobs={sourceJobsForStep2}
							onImport={hasImportSource ? handleImportAll : undefined}
							importLabel={importLabel}
							importLoading={importingLineItems}
							stickyHeader
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={setLineItemTaxGroup}
							onTaxGroupBulkSet={setAllLineItemsTaxGroup}
						/>
					</div>
				);
			}

			case 3: {
				const dueDateLabel = dueDate
					? dueDate.toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							year: "numeric",
						})
					: null;

				return (
					<div className="space-y-3 lg:space-y-5 xl:space-y-6 min-w-0">
						<FormErrorBanner message={submitError} />
						<div className="p-3 bg-surface/50 rounded-lg border border-border/50 text-sm space-y-1.5">
							<div className="flex justify-between items-center">
								<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
									Client
								</span>
								<span className="text-text-primary font-medium">
									{clients?.find(
										(c) =>
											c.id ===
											clientId
									)?.name ?? "—"}
								</span>
							</div>
							{memo && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Memo
									</span>
									<span className="text-text-primary truncate max-w-[60%] text-right">
										{memo}
									</span>
								</div>
							)}
							{paymentTermsDays && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Payment Terms
									</span>
									<span className="text-text-primary">
										{paymentTermsDays ===
										"0"
											? "Due on Receipt"
											: `Net ${paymentTermsDays}`}
									</span>
								</div>
							)}
							{dueDateLabel && (
								<div className="flex justify-between items-center">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Due Date
									</span>
									<span className="text-text-primary">
										{dueDateLabel}
									</span>
								</div>
							)}
							{linkedJobIds.size > 0 && (
								<div className="flex justify-between items-start">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Linked Jobs
									</span>
									<span className="text-primary-text text-right">
										{linkedJobIds.size}{" "}
										job
										{linkedJobIds.size !==
										1
											? "s"
											: ""}
									</span>
								</div>
							)}
							{visitBillings.size > 0 && (
								<div className="flex justify-between items-start">
									<span className="text-text-tertiary text-xs uppercase tracking-wide font-semibold">
										Linked Visits
									</span>
									<span className="text-primary-text text-right">
										{visitBillings.size}{" "}
										visit
										{visitBillings.size !==
										1
											? "s"
											: ""}
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
							mode="create"
							onTaxRateChange={groupsSummary.length > 0 ? undefined : (v) => {
								setTaxRate(v);
								markDirty();
							}}
							onDiscountTypeChange={(v) => {
								setDiscountType(v);
								markDirty();
							}}
							onDiscountValueChange={(v) => {
								setDiscountValue(v);
								markDirty();
							}}
							totalLabel="Invoice Total"
							isTaxDirty={isTaxDirty}
							isDiscountDirty={isDiscountDirty}
							onTaxUndo={undoTax}
							onDiscountUndo={undoDiscount}
						/>
					</div>
				);
			}

			default:
				return null;
		}
	}, [
		currentStep,
		clientId,
		memo,
		internalNotes,
		paymentTermsDays,
		dueDate,
		linkedJobIds,
		expandedJobs,
		visitBillings,
		clientJobs,
		jobBillingMap,
		visitBillingMap,
		isLoading,
		clientDropdownEntries,
		paymentTermsEntries,
		toggleJobLinked,
		toggleJobExpanded,
		toggleVisitSelected,
		updateLineItemSource,
		activeLineItems,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		undoLineItemSource,
		originalLineItems,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,
		groupsSummary,
		totalTax,
		clientExempt,
		taxGroups,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
		clients,
		defaultClientId,
		importSources,
		handleImportAll,
		submitError,
		qbConnected,
		qbSearchOpen,
		qbInvoiceResults,
		qbInvoiceClients,
		qbInvoicesLoading,
		handleSelectQBInvoice,
		selectedQBInvoice,
		selectedQBLabel,
		qbPrefillLoading,
	]);

	return (
		<>
		{showOverlapModal && (
			<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
				<div className="w-full max-w-lg rounded-lg border border-border bg-base p-6 shadow-xl">
					<h3 className="mb-1 text-base font-semibold text-text-primary">Visits Already Billed</h3>
					<p className="mb-4 text-sm text-text-tertiary">
						These visits are on active invoices. You can still proceed — this may be intentional
						(partial billing, corrections).
					</p>
					<ul className="mb-5 space-y-2">
						{overlapWarnings.map((w) => (
							<li key={w.visit_id} className="rounded border border-border bg-surface p-3 text-sm">
								<span className="font-medium text-text-primary">
									{new Date(w.scheduled_start_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
								</span>
								<ul className="mt-1 space-y-0.5 text-text-tertiary">
									{w.existing_invoices.map((inv) => (
										<li key={inv.invoice_id}>
											{inv.invoice_number} —{" "}
											<span className="text-text-secondary">{InvoiceStatusLabels[inv.status as InvoiceStatus] ?? inv.status}</span>
											{inv.billed_amount != null && (
												<span className="ml-1 text-text-tertiary">(${inv.billed_amount.toFixed(2)} billed)</span>
											)}
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
					<div className="flex justify-end gap-3">
						<button
							onClick={() => setShowOverlapModal(false)}
							className="rounded px-4 py-2 text-sm text-text-secondary hover:bg-surface"
						>
							Go Back
						</button>
						<button
							onClick={() => {
								setShowOverlapModal(false);
								goNext();
							}}
							className="rounded bg-primary-hover px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary"
						>
							Continue Anyway
						</button>
					</div>
				</div>
			</div>
		)}
		<FormWizardContainer<Step>
			title="Create Invoice"
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={goToStep}
			onNext={handleNext}
			onBack={goBack}
			onSubmit={invokeCreate}
			canGoNext={canGoNext && !isCheckingOverlap}
			submitLabel="Create Invoice"
			isSourceSearchOpen={qbSearchOpen}
			sourceMode="existing"
			onSourceModeChange={() => {}}
			hideSourceToggle={true}
			draftCount={0}
			onStartFromExisting={() => setQbSearchOpen(true)}
			startFromExistingLabel="Import from QuickBooks"
			hideStartFromExisting={!qbConnected}
			fullHeightContent={qbSearchOpen}
			onCloseSourceSearch={() => setQbSearchOpen(false)}
			canSaveDraft={false}
			isSavingDraft={false}
		>
			{stepContent}
		</FormWizardContainer>
		</>
	);
};

export default CreateInvoice;
