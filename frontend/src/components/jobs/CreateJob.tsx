import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import {
	CreateJobSchema,
	type CreateJobInput,
	type CreateJobLineItemInput,
	JobStatusColors,
} from "../../types/jobs";
import {
	type LineItemType,
	type BaseLineItem,
	type Priority,
	PriorityValues,
} from "../../types/common";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { useAllJobsQuery } from "../../hooks/useJobs";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import {
	useDraftsByTypeQuery,
	useCreateDraftMutation,
	useUpdateDraftMutation,
	useDeleteDraftMutation,
} from "../../hooks/forms/useDrafts";
import { getDraft } from "../../api/drafts";
import type { DraftSummary, SourceType } from "../../types/drafts";
import type { GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import LineItemsSection from "../ui/forms/LineItemsSection";
import FinancialSummary from "../ui/forms/FinancialSummary";
import {
	TemplateSearch,
	type TemplateSearchResult,
	type TemplateSearchClient,
} from "../ui/forms/TemplateSearch";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";

type Step = 1 | 2 | 3;

interface CreateJobProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createJob: (input: CreateJobInput) => Promise<string>;
}

const STEPS = [
	{ id: 1 as Step, label: "Basics" },
	{ id: 2 as Step, label: "Line Items" },
	{ id: 3 as Step, label: "Finalize" },
];

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v} className="text-black">
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const CreateJob = ({ isModalOpen, setIsModalOpen, createJob }: CreateJobProps) => {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [clientId, setClientId] = useState("");
	const [priority, setPriority] = useState<Priority>("Medium");
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);

	const [sourceMode, setSourceMode] = useState<SourceType | null>(null);
	const [sourceClientFilter, setSourceClientFilter] = useState("");

	const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
	const [isDirty, setIsDirty] = useState(false);

	const { data: clients } = useAllClientsQuery();
	const { data: allJobs = [] } = useAllJobsQuery();
	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const { data: drafts = [] } = useDraftsByTypeQuery("job");
	const createDraftMutation = useCreateDraftMutation();
	const updateDraftMutation = useUpdateDraftMutation();
	const deleteDraftMutation = useDeleteDraftMutation();

	const isSourceSearchOpen = sourceMode !== null;

	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		seedLineItems,
		subtotal,
		resetLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		setLineItemInventoryItem,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
	} = useLineItems({ minItems: 0, mode: "create" });

	const { data: taxGroups = [] } = useTaxGroups();

	const selectedClient = useMemo(
		() => clients?.find((c) => c.id === clientId) ?? null,
		[clients, clientId],
	);
	const clientExempt = selectedClient?.is_tax_exempt ?? false;

	const lineItemsForCalc = useMemo(
		() =>
			activeLineItems.map((item) => ({
				id: item.id,
				total: Number(item.total),
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
			})),
		[activeLineItems],
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
		reset: resetFinancials,
		setOriginals: setFinancialOriginals,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		groupsSummary,
		totalTax,
		resolvedTaxRate,
		resolvedTaxAmount,
		resolvedTotal,
	} = useFinancialCalculations(subtotal, {
		taxGroups,
		lineItemsForCalc,
		clientExempt,
		initialDiscountType: "amount",
		initialDiscountValue: 0,
	});

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 3 as Step, initialStep: 1 as Step });

	const validateStep1 = useCallback(
		(): boolean =>
			!!(
				name.trim() &&
				clientId.trim() &&
				description.trim() &&
				geoData?.address &&
				priority
			),
		[name, clientId, description, geoData, priority]
	);

	const validateStep2 = useCallback((): boolean => {
		const meaningful = activeLineItems.filter((item) => {
			const hasText =
				item.name.trim() !== "" || (item.description?.trim() ?? "") !== "";
			const hasNumbers = Number(item.unit_price) > 0;
			const hasType = (item.item_type?.trim?.() ?? "") !== "";
			return hasText || hasNumbers || hasType;
		});
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
			if (targetStep === currentStep) return true;
			if (visitedSteps.has(targetStep)) return true;
			if (targetStep === currentStep + 1 && validateStep(currentStep))
				return true;
			return false;
		},
		[currentStep, visitedSteps, validateStep]
	);

	const resetForm = useCallback(() => {
		resetWizard();
		setName("");
		setDescription("");
		setClientId("");
		setPriority("Medium");
		setGeoData(undefined);
		resetLineItems();
		resetFinancials();
		setErrors(null);
		setSourceMode(null);
		setSourceClientFilter("");
		setCurrentDraftId(null);
		setIsDirty(false);
	}, [resetWizard, resetLineItems, resetFinancials]);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	const markDirty = useCallback(() => setIsDirty(true), []);
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

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
		markDirty();
	};
	const handleClearAddress = () => setGeoData(undefined);

	const handleSelectTemplate = useCallback(
		(jobId: string) => {
			const source = allJobs.find((j) => j.id === jobId);
			if (!source) return;

			setName(source.name);
			setDescription(source.description);
			setClientId(source.client_id ?? "");
			setPriority(source.priority as Priority);
			const lat = source.coords?.lat;
			const lon = source.coords?.lon;
			if (
				source.address &&
				Number.isFinite(lat) &&
				Number.isFinite(lon) &&
				(lat !== 0 || lon !== 0)
			) {
				setGeoData({ address: source.address, coords: { lat, lon } });
			}

			if (source.line_items?.length) {
				seedLineItems(
					source.line_items.map((li) => ({
						name: li.name,
						description: li.description ?? "",
						quantity: Number(li.quantity),
						unit_price: Number(li.unit_price),
						item_type: (li.item_type ?? "") as
							| LineItemType
							| "",
						taxable: li.taxable ?? true,
						tax_group_id: li.tax_group_id ?? null,
						inventory_item_id: li.inventory_item_id ?? null,
					}))
				);
			} else {
				resetLineItems();
			}

			setFinancialOriginals(
				(source.tax_rate ?? 0) * 100,
				source.discount_type ?? "amount",
				source.discount_value ?? 0
			);

			setCurrentDraftId(null);
			setIsDirty(true); // pre-filled — allow saving as draft
			setSourceMode(null);
			goToStep(1 as Step);
		},
		[allJobs, seedLineItems, resetLineItems, setFinancialOriginals, goToStep]
	);

	const handleSelectDraft = useCallback(
		async (draftId: string) => {
			try {
				const draft = await getDraft(draftId);
				const p = draft.payload as Partial<CreateJobInput>;

				setName(p.name || "");
				setDescription(p.description || "");
				setClientId(p.client_id || "");
				setPriority((p.priority as Priority) || "Medium");
				if (p.address) {
					setGeoData({
						address: p.address,
						coords: p.coords || { lat: 0, lon: 0 },
					});
				}
				if (p.line_items?.length) {
					seedLineItems(
						p.line_items.map((li) => ({
							name: li.name,
							description: li.description ?? "",
							quantity: Number(li.quantity),
							unit_price: Number(li.unit_price),
							item_type: (li.item_type ?? "") as
								| LineItemType
								| "",
							taxable: li.taxable ?? true,
							tax_group_id: li.tax_group_id ?? null,
							inventory_item_id: li.inventory_item_id ?? null,
						}))
					);
				}
				if (p.tax_rate != null) {
					setFinancialOriginals(
						p.tax_rate * 100,
						p.discount_type ?? "amount",
						p.discount_value ?? 0
					);
				}

				setCurrentDraftId(draft.id);
				setIsDirty(false);
				setSourceMode(null);
				goToStep(1 as Step);
			} catch (err) {
				console.error("Failed to load draft:", err);
			}
		},
		[seedLineItems, setFinancialOriginals, goToStep]
	);

	const handleSaveDraft = useCallback(async () => {
		const payload: Record<string, unknown> = {
			name,
			description,
			client_id: clientId,
			priority,
			address: geoData?.address,
			coords: geoData?.coords,
			line_items: activeLineItems.map((item) => ({
				name: item.name,
				description: item.description,
				quantity: item.quantity,
				unit_price: item.unit_price,
				item_type: item.item_type,
				total: item.total,
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
				inventory_item_id: item.inventory_item_id ?? null,
			})),
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			estimated_total: resolvedTotal,
		};
		try {
			if (currentDraftId) {
				await updateDraftMutation.mutateAsync({
					id: currentDraftId,
					input: { payload },
				});
			} else {
				const draft = await createDraftMutation.mutateAsync({
					form_type: "job",
					payload,
					entity_context_id: null,
				});
				setCurrentDraftId(draft.id);
			}
			setIsDirty(false);
		} catch (err) {
			console.error("Failed to save draft:", err);
		}
	}, [
		name,
		description,
		clientId,
		priority,
		geoData,
		activeLineItems,
		discountType,
		discountValue,
		discountAmount,
		resolvedTaxRate,
		resolvedTaxAmount,
		resolvedTotal,
		currentDraftId,
		createDraftMutation,
		updateDraftMutation,
	]);

	const handleDeleteDraft = useCallback(
		async (draftId: string) => {
			try {
				await deleteDraftMutation.mutateAsync(draftId);
				if (draftId === currentDraftId) {
					setCurrentDraftId(null);
					setIsDirty(false);
				}
			} catch (err) {
				console.error("Failed to delete draft:", err);
			}
		},
		[currentDraftId, deleteDraftMutation]
	);

	const templateResults = useMemo((): TemplateSearchResult[] => {
		return allJobs
			.filter((j) => j.status !== "Cancelled")
			.map((j) => ({
				id: j.id,
				title: j.name,
				subtitle: j.job_number,
				detail: j.description
					? j.description.slice(0, 80) +
						(j.description.length > 80 ? "…" : "")
					: undefined,
				badge: j.status,
				badgeColor: JobStatusColors[
					j.status as keyof typeof JobStatusColors
				],
				value:
					j.estimated_total != null
						? `$${Number(j.estimated_total).toFixed(2)}`
						: undefined,
				createdAt: new Date(j.created_at).toISOString(),
				clientId: j.client_id,
				clientName: j.client?.name,
			}));
	}, [allJobs]);

	const templateClients = useMemo((): TemplateSearchClient[] => {
		if (!clients) return [];
		return clients.map((c) => ({ id: c.id, name: c.name }));
	}, [clients]);

	const draftResults = useMemo((): TemplateSearchResult[] => {
		return drafts.map((d: DraftSummary) => ({
			id: d.id,
			title: d.label || "Untitled Draft",
			subtitle: (() => {
				const diff = Date.now() - new Date(d.updated_at).getTime();
				const mins = Math.floor(diff / 60000);
				const hrs = Math.floor(diff / 3600000);
				const days = Math.floor(diff / 86400000);
				if (mins < 1) return "Updated just now";
				if (mins < 60) return `Updated ${mins}m ago`;
				if (hrs < 24) return `Updated ${hrs}h ago`;
				if (days < 7) return `Updated ${days}d ago`;
				return `Updated ${new Date(d.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
			})(),
			value:
				d.total != null && d.total !== 0
					? `$${Number(d.total).toFixed(2)}`
					: undefined,
			createdAt: d.created_at,
			isDeletable: true,
			clientId: d.client_id ?? undefined,
			clientName: d.client_id
				? templateClients.find((c) => c.id === d.client_id)?.name
				: undefined,
		}));
	}, [drafts, templateClients]);

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

	const invokeCreate = async () => {
		if (isLoading) return;

		const preparedLineItems: CreateJobLineItemInput[] = activeLineItems
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
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
				inventory_item_id: item.inventory_item_id ?? null,
			}));

		const newJob: CreateJobInput = {
			name: name.trim(),
			client_id: clientId.trim(),
			address: geoData?.address || "",
			coords: geoData?.coords,
			description: description.trim(),
			priority: priority as Priority,
			subtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			estimated_total: resolvedTotal,
			line_items: preparedLineItems.length ? preparedLineItems : undefined,
		};

		const parseResult = CreateJobSchema.safeParse(newJob);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			const errorPaths = parseResult.error.issues.map((i) => i.path[0]);
			if (
				errorPaths.some((p) =>
					[
						"name",
						"client_id",
						"description",
						"address",
						"coords",
						"priority",
					].includes(String(p))
				)
			) {
				goToStep(1 as Step);
			} else if (errorPaths.includes("line_items")) {
				goToStep(2 as Step);
			}
			return;
		}

		setErrors(null);
		setIsLoading(true);
		try {
			await createJob(newJob);
			if (currentDraftId) {
				await deleteDraftMutation
					.mutateAsync(currentDraftId)
					.catch(() => {});
			}
			setIsModalOpen(false);
			resetForm();
		} catch (error) {
			console.error("Failed to create job:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const ErrorDisplay = ({ path }: { path: string }) => {
		if (!errors) return null;
		const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
		if (!fieldErrors.length) return null;
		return (
			<div className="mt-0.5">
				{fieldErrors.map((err, idx) => (
					<p key={idx} className="text-error-text text-xs leading-tight">
						{err.message}
					</p>
				))}
			</div>
		);
	};

	const stepContent = useMemo(() => {
		if (isSourceSearchOpen) {
			if (sourceMode === "draft") {
				return (
					<TemplateSearch
						heading="Use Draft"
						placeholder="Search drafts by name..."
						results={draftResults}
						clients={templateClients}
						onSelect={handleSelectDraft}
						onClose={() => setSourceMode(null)}
						onDelete={handleDeleteDraft}
						isDeletingId={
							deleteDraftMutation.isPending
								? (deleteDraftMutation.variables as string)
								: null
						}
						clientFilter={sourceClientFilter}
						onClientFilterChange={setSourceClientFilter}
					/>
				);
			}
			return (
				<TemplateSearch
					results={templateResults}
					clients={templateClients}
					onSelect={handleSelectTemplate}
					onClose={() => setSourceMode(null)}
					clientFilter={sourceClientFilter}
					onClientFilterChange={setSourceClientFilter}
				/>
			);
		}

		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<div className="min-w-0">
							<label className={LABEL}>Job Name *</label>
							<input
								type="text"
								placeholder="Job Name"
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									markDirty();
								}}
								className={INPUT}
								disabled={isLoading}
							/>
							<ErrorDisplay path="name" />
						</div>

						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Client *
								</label>
								<Dropdown
									entries={
										clientDropdownEntries
									}
									value={clientId}
									onChange={(v) => {
										setClientId(v);
										markDirty();
										const client = clients?.find((c) => c.id === v);
										if (client?.address && Number.isFinite(client.coords?.lat) && Number.isFinite(client.coords?.lon)) {
											setGeoData({ address: client.address, coords: { lat: client.coords.lat, lon: client.coords.lon } });
										}
									}}
									placeholder="Select client"
									disabled={isLoading}
									error={errors?.issues.some(
										(e) =>
											e
												.path[0] ===
											"client_id"
									)}
								/>
								<ErrorDisplay path="client_id" />
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Priority *
								</label>
								<Dropdown
									entries={PRIORITY_ENTRIES}
									value={priority}
									onChange={(v) => {
										setPriority(
											v as Priority
										);
										markDirty();
									}}
									defaultValue="Medium"
									disabled={isLoading}
									error={errors?.issues.some(
										(e) =>
											e
												.path[0] ===
											"priority"
									)}
								/>
								<ErrorDisplay path="priority" />
							</div>
						</div>

						<div className="min-w-0">
							<label className={LABEL}>
								Description *
							</label>
							<textarea
								placeholder="Job Description"
								value={description}
								onChange={(e) => {
									setDescription(
										e.target.value
									);
									markDirty();
								}}
								className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
								disabled={isLoading}
							/>
							<ErrorDisplay path="description" />
						</div>

						<div
							className="relative min-w-0"
							style={{ zIndex: 50 }}
						>
							<label className={LABEL}>Address *</label>
							<AddressForm
								mode={geoData ? "edit" : "create"}
								originalValue={
									geoData?.address || ""
								}
								originalCoords={geoData?.coords}
								dropdownPosition="above"
								handleChange={handleChangeAddress}
								handleClear={handleClearAddress}
							/>
							<ErrorDisplay path="address" />
							<ErrorDisplay path="coords" />
						</div>
					</div>
				);

			case 2:
				return (
					<div className="min-w-0 flex flex-col">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							onLinkInventory={setLineItemInventoryItem}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={dirtyAddLineItem}
							onRemove={dirtyRemoveLineItem}
							onUpdate={dirtyUpdateLineItem}
							subtotal={subtotal}
							required={false}
							minItems={0}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
							inventoryItems={inventoryItems}
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={(id, groupId, taxable) => {
								setLineItemTaxGroup(id, groupId, taxable);
								markDirty();
							}}
							onTaxGroupBulkSet={(groupId, taxable) => {
								setAllLineItemsTaxGroup(groupId, taxable);
								markDirty();
							}}
						/>
				</div>
			);

			case 3:
				return (
					<div className="space-y-3 lg:space-y-5 xl:space-y-6 min-w-0">
						<FinancialSummary
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							discountType={discountType}
							discountValue={discountValue}
							discountAmount={discountAmount}
							total={total}
							isLoading={isLoading}
							mode="create"
							onTaxRateChange={(v) => {
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
							totalLabel="Estimated Total"
							isTaxDirty={isTaxDirty}
							isDiscountDirty={isDiscountDirty}
							onTaxUndo={undoTax}
							onDiscountUndo={undoDiscount}
							groupsSummary={groupsSummary}
							totalTax={totalTax}
						/>
					</div>
				);

			default:
				return null;
		}
	}, [
		isSourceSearchOpen,
		sourceMode,
		draftResults,
		templateClients,
		handleSelectDraft,
		handleDeleteDraft,
		sourceClientFilter,
		templateResults,
		handleSelectTemplate,
		currentStep,
		name,
		clientId,
		priority,
		description,
		isLoading,
		clientDropdownEntries,
		geoData,
		errors,
		activeLineItems,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		inventoryItems,
		taxGroups,
		clientExempt,
		groupsSummary,
		totalTax,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
	]);

	return (
		<FormWizardContainer<Step>
			title="Create Job"
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
			onSubmit={invokeCreate}
			canGoNext={canGoNext}
			submitLabel="Create Job"
			isSourceSearchOpen={isSourceSearchOpen}
			sourceMode={sourceMode || "existing"}
			onSourceModeChange={(mode) => setSourceMode(mode)}
			draftCount={drafts.length}
			onStartFromExisting={() => setSourceMode("existing")}
			hideStartFromExisting={isSourceSearchOpen}
			fullHeightContent={isSourceSearchOpen}
			onCloseSourceSearch={() => setSourceMode(null)}
			onSaveDraft={handleSaveDraft}
			canSaveDraft={
				isDirty &&
				!!(
					name.trim() ||
					description.trim() ||
					clientId ||
					geoData?.address ||
					activeLineItems.some(
						(i) =>
							i.name.trim() ||
							i.quantity > 0 ||
							i.unit_price > 0
					)
				)
			}
			isSavingDraft={
				createDraftMutation.isPending || updateDraftMutation.isPending
			}
		>
			{stepContent}
		</FormWizardContainer>
	);
};

export default CreateJob;
