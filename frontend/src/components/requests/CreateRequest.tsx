import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ZodError } from "zod";
import { CreateRequestSchema, type CreateRequestInput } from "../../types/requests";
import { type Priority, PriorityValues } from "../../types/common";
import { useAllClientsQuery } from "../../hooks/useClients";
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
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import {
	TemplateSearch,
	type TemplateSearchResult,
	type TemplateSearchClient,
} from "../ui/forms/TemplateSearch";
import { errorMessage } from "../../util/util";
import { ChevronDown, ChevronUp } from "lucide-react";

interface CreateRequestProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createRequest: (input: CreateRequestInput) => Promise<string>;
}

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v} className="text-black">
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

const CreateRequest = ({ isModalOpen, setIsModalOpen, createRequest }: CreateRequestProps) => {
	const navigate = useNavigate();

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [clientId, setClientId] = useState("");
	const [priority, setPriority] = useState<Priority>("Medium");
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [source, setSource] = useState("");
	const [sourceReference, setSourceReference] = useState("");
	const [requiresQuote, setRequiresQuote] = useState(false);
	const [estimatedValue, setEstimatedValue] = useState("");
	const [showAdditional, setShowAdditional] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const [sourceMode, setSourceMode] = useState<SourceType | null>(null);
	const [sourceClientFilter, setSourceClientFilter] = useState("");

	const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
	const [isDirty, setIsDirty] = useState(false);

	const { data: clients } = useAllClientsQuery();
	const { data: drafts = [] } = useDraftsByTypeQuery("request");
	const createDraftMutation = useCreateDraftMutation();
	const updateDraftMutation = useUpdateDraftMutation();
	const deleteDraftMutation = useDeleteDraftMutation();

	const isSourceSearchOpen = sourceMode !== null;

	const markDirty = useCallback(() => setIsDirty(true), []);

	const resetForm = useCallback(() => {
		setTitle("");
		setDescription("");
		setClientId("");
		setPriority("Medium");
		setGeoData(undefined);
		setSource("");
		setSourceReference("");
		setRequiresQuote(false);
		setEstimatedValue("");
		setShowAdditional(false);
		setErrors(null);
		setSubmitError(null);
		setSourceMode(null);
		setSourceClientFilter("");
		setCurrentDraftId(null);
		setIsDirty(false);
	}, []);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	useEffect(() => {
		if (!source.trim()) setSourceReference("");
	}, [source]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
		markDirty();
	};
	const handleClearAddress = () => setGeoData(undefined);

	const handleSelectDraft = useCallback(async (draftId: string) => {
		try {
			const draft = await getDraft(draftId);
			const p = draft.payload as Partial<CreateRequestInput>;

			setTitle(p.title || "");
			setDescription(p.description || "");
			setClientId(p.client_id || "");
			setPriority((p.priority as Priority) || "Medium");
			if (p.address) {
				setGeoData({
					address: p.address,
					coords: p.coords || { lat: 0, lon: 0 },
				});
			}
			setSource(p.source || "");
			setSourceReference(p.source_reference || "");
			setRequiresQuote(p.requires_quote ?? false);
			setEstimatedValue(
				p.estimated_value != null ? String(p.estimated_value) : ""
			);
			if (
				p.source ||
				p.source_reference ||
				p.requires_quote ||
				p.estimated_value
			) {
				setShowAdditional(true);
			}

			setCurrentDraftId(draft.id);
			setIsDirty(false);
			setSourceMode(null);
		} catch (err) {
			console.error("Failed to load draft:", err);
		}
	}, []);

	const handleSaveDraft = useCallback(async () => {
		const payload: Record<string, unknown> = {
			title,
			description,
			client_id: clientId,
			priority,
			address: geoData?.address,
			coords: geoData?.coords,
			source: source || null,
			source_reference: sourceReference || null,
			requires_quote: requiresQuote,
			estimated_value: estimatedValue ? parseFloat(estimatedValue) : null,
		};
		try {
			if (currentDraftId) {
				await updateDraftMutation.mutateAsync({
					id: currentDraftId,
					input: { payload },
				});
			} else {
				const draft = await createDraftMutation.mutateAsync({
					form_type: "request",
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
		title,
		description,
		clientId,
		priority,
		geoData,
		source,
		sourceReference,
		requiresQuote,
		estimatedValue,
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

		const newRequest: CreateRequestInput = {
			title: title.trim(),
			client_id: clientId.trim(),
			address: geoData?.address,
			coords: geoData?.coords,
			description: description.trim(),
			priority: priority as Priority,
			status: "Reviewing",
			source: source.trim() || null,
			source_reference: sourceReference.trim() || null,
			requires_quote: requiresQuote,
			estimated_value: estimatedValue ? parseFloat(estimatedValue) : null,
		};

		const parseResult = CreateRequestSchema.safeParse(newRequest);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			return;
		}

		setErrors(null);
		setSubmitError(null);
		setIsLoading(true);
		try {
			const requestId = await createRequest(parseResult.data);
			if (currentDraftId) {
				await deleteDraftMutation
					.mutateAsync(currentDraftId)
					.catch(() => {});
			}
			setIsModalOpen(false);
			resetForm();
			navigate(`/dispatch/requests/${requestId}`);
		} catch (error) {
			console.error("Failed to create request:", error);
			setSubmitError(
				errorMessage(error, "Failed to create request. Please try again.")
			);
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

	const isFormValid = useMemo(
		() => !!(title.trim() && clientId.trim() && description.trim() && priority),
		[title, clientId, description, priority]
	);

	const additionalPreviewTags = useMemo(() => {
		const tags: string[] = [];
		if (source.trim()) tags.push(source.trim());
		if (sourceReference.trim()) tags.push(sourceReference.trim());
		if (requiresQuote) tags.push("Req. Quote");
		if (estimatedValue) tags.push(`$${estimatedValue}`);
		return tags;
	}, [source, sourceReference, requiresQuote, estimatedValue]);

	const formContent = useMemo(() => {
		if (isSourceSearchOpen) {
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
			<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
				<div className="min-w-0">
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Title *
					</label>
					<input
						type="text"
						placeholder="Request Title"
						value={title}
						onChange={(e) => {
							setTitle(e.target.value);
							markDirty();
						}}
						className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0"
						disabled={isLoading}
					/>
					<ErrorDisplay path="title" />
				</div>

				<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
							Client *
						</label>
						<Dropdown
							entries={clientDropdownEntries}
							value={clientId}
							onChange={(v) => {
								setClientId(v);
								markDirty();
							}}
							placeholder="Select client"
							disabled={isLoading}
							error={errors?.issues.some(
								(e) => e.path[0] === "client_id"
							)}
						/>
						<ErrorDisplay path="client_id" />
					</div>
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
							Priority
						</label>
						<Dropdown
							entries={PRIORITY_ENTRIES}
							value={priority}
							onChange={(v) => {
								setPriority(v as Priority);
								markDirty();
							}}
							defaultValue="Medium"
							disabled={isLoading}
							error={errors?.issues.some(
								(e) => e.path[0] === "priority"
							)}
						/>
						<ErrorDisplay path="priority" />
					</div>
				</div>

				<div className="min-w-0">
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Description *
					</label>
					<textarea
						placeholder="Request Description"
						value={description}
						onChange={(e) => {
							setDescription(e.target.value);
							markDirty();
						}}
						className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
						disabled={isLoading}
					/>
					<ErrorDisplay path="description" />
				</div>

				<div className="relative min-w-0" style={{ zIndex: 50 }}>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Address (Optional)
					</label>
					<AddressForm
						mode={geoData ? "edit" : "create"}
						originalValue={geoData?.address || ""}
						originalCoords={geoData?.coords}
						dropdownPosition="above"
						handleChange={handleChangeAddress}
						handleClear={handleClearAddress}
					/>
					<ErrorDisplay path="address" />
					<ErrorDisplay path="coords" />
				</div>

				{/* Additional Details Toggle */}
				<div className="min-w-0">
					<button
						type="button"
						onClick={() => setShowAdditional((v) => !v)}
						disabled={isLoading}
						className="w-full flex items-center justify-between px-2.5 py-1.5 rounded border border-border bg-surface/50 hover:bg-surface transition-colors text-xs font-medium text-text-tertiary uppercase tracking-wider disabled:opacity-50"
					>
						<span className="flex items-center gap-2">
							Additional Optional Details
							{!showAdditional &&
								additionalPreviewTags.length >
									0 && (
									<span className="flex items-center gap-1 normal-case">
										{additionalPreviewTags.map(
											(
												tag,
												i
											) => (
												<span
													key={
														i
													}
													className="px-1.5 py-0.5 rounded bg-surface-raised text-text-secondary text-[10px] font-normal tracking-normal"
												>
													{
														tag
													}
												</span>
											)
										)}
									</span>
								)}
						</span>
						{showAdditional ? (
							<ChevronUp size={14} />
						) : (
							<ChevronDown size={14} />
						)}
					</button>

					{showAdditional && (
						<div className="mt-2 space-y-2 lg:space-y-3 pl-0.5">
							<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
								<div className="min-w-0">
									<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
										Source
									</label>
									<input
										type="text"
										placeholder="e.g., Phone Call, Website"
										value={source}
										onChange={(e) => {
											setSource(
												e
													.target
													.value
											);
											markDirty();
										}}
										className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0"
										disabled={isLoading}
									/>
								</div>
								{source.trim() ? (
									<div className="min-w-0">
										<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
											Source
											Reference
										</label>
										<input
											type="text"
											placeholder="e.g., Ticket #12345"
											value={
												sourceReference
											}
											onChange={(
												e
											) => {
												setSourceReference(
													e
														.target
														.value
												);
												markDirty();
											}}
											className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0"
											disabled={
												isLoading
											}
										/>
									</div>
								) : (
									<div className="min-w-0" />
								)}
							</div>

							<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
								<div className="min-w-0">
									<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
										Estimated Value
									</label>
									<div className="relative">
										<span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-sm">
											$
										</span>
										<input
											type="number"
											step="0.01"
											min="0"
											placeholder="0.00"
											value={
												estimatedValue
											}
											onChange={(
												e
											) => {
												setEstimatedValue(
													e
														.target
														.value
												);
												markDirty();
											}}
											className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pl-7 min-w-0"
											disabled={
												isLoading
											}
										/>
									</div>
								</div>
								<div className="flex items-end pb-1.5 lg:pb-3.5 min-w-0">
									<input
										type="checkbox"
										id="requires_quote"
										checked={
											requiresQuote
										}
										onChange={(e) => {
											setRequiresQuote(
												e
													.target
													.checked
											);
											markDirty();
										}}
										className="w-4 h-4 rounded border-border bg-base text-primary-hover focus:ring-primary focus:ring-2 cursor-pointer"
										disabled={isLoading}
									/>
									<label
										htmlFor="requires_quote"
										className="ml-2 text-xs lg:text-sm text-text-tertiary cursor-pointer"
									>
										Requires Quote
									</label>
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}, [
		isSourceSearchOpen,
		draftResults,
		templateClients,
		handleSelectDraft,
		handleDeleteDraft,
		sourceClientFilter,
		title,
		clientId,
		priority,
		description,
		isLoading,
		clientDropdownEntries,
		geoData,
		errors,
		source,
		sourceReference,
		requiresQuote,
		estimatedValue,
		showAdditional,
		additionalPreviewTags,
		markDirty,
	]);

	return (
		<FormWizardContainer
			title="Create Request"
			steps={[]}
			currentStep={1 as never}
			visitedSteps={new Set([1 as never])}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSubmit={invokeCreate}
			canGoNext={isFormValid}
			submitLabel="Create Request"
			// Draft / source search
			isSourceSearchOpen={isSourceSearchOpen}
			sourceMode="draft"
			onSourceModeChange={() => {}} // single mode — toggle not needed
			draftsOnly
			draftCount={drafts.length}
			onStartFromExisting={() => setSourceMode("draft")}
			startFromExistingLabel="Use Draft"
			hideStartFromExisting={isSourceSearchOpen}
			fullHeightContent={isSourceSearchOpen}
			onCloseSourceSearch={() => setSourceMode(null)}
			// Save draft
			onSaveDraft={handleSaveDraft}
			canSaveDraft={
				isDirty &&
				!!(
					title.trim() ||
					description.trim() ||
					clientId ||
					geoData?.address ||
					source.trim() ||
					estimatedValue ||
					requiresQuote
				)
			}
			isSavingDraft={
				createDraftMutation.isPending || updateDraftMutation.isPending
			}
		>
			<>
				<FormErrorBanner message={submitError} className="mb-2" />
				{formContent}
			</>
		</FormWizardContainer>
	);
};

export default CreateRequest;
