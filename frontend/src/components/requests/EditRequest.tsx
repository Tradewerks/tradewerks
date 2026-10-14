import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import { useUpdateRequestMutation } from "../../hooks/useRequests";
import { UpdateRequestSchema, type Request, type UpdateRequestInput } from "../../types/requests";
import { type Priority, PriorityValues } from "../../types/common";
import { normalizeCoords, type Coordinates, type GeocodeResult } from "../../types/location";
import AddressForm from "../ui/AddressForm";
import Dropdown from "../ui/Dropdown";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { UndoButton, UndoButtonTop } from "../ui/forms/UndoButton";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";
import { errorMessage } from "../../util/util";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

interface EditRequestProps {
	isModalOpen: boolean;
	setIsModalOpen: (isOpen: boolean) => void;
	request: Request;
}

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v}>
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

export default function EditRequest({ isModalOpen, setIsModalOpen, request }: EditRequestProps) {
	const updateRequest = useUpdateRequestMutation();

	const [geoData, setGeoData] = useState<{ address: string; coords?: Coordinates }>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [showAdditional, setShowAdditional] = useState(false);

	const requestCoords = useMemo(() => normalizeCoords(request.coords), [request.coords]);

	type FormFields = {
		title: string;
		description: string;
		priority: Priority;
		source: string;
		sourceReference: string;
		requiresQuote: boolean;
		estimatedValue: string;
	};

	const { updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			title: "",
			description: "",
			priority: "Medium",
			source: "",
			sourceReference: "",
			requiresQuote: false,
			estimatedValue: "",
		});

	useEffect(() => {
		if (isModalOpen && request) {
			const initialOriginals: FormFields = {
				title: request.title ?? "",
				description: request.description ?? "",
				priority: request.priority,
				source: request.source ?? "",
				sourceReference: request.source_reference ?? "",
				requiresQuote: !!request.requires_quote,
				estimatedValue:
					request.estimated_value !== null &&
					request.estimated_value !== undefined
						? String(request.estimated_value)
						: "",
			};

			setOriginals(initialOriginals);

			setGeoData(
				request.address || requestCoords
					? { address: request.address || "", coords: requestCoords }
					: undefined
			);

			setShowAdditional(false);

			setErrors(null);
			setSubmitError(null);
		}
	}, [isModalOpen, request, requestCoords, setOriginals]);

	useEffect(() => {
		if (!getValue("source").trim()) {
			updateField("sourceReference", "");
		}
	}, [getValue("source")]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
	};

	const handleClearAddress = () => {
		if (request.address || requestCoords) {
			setGeoData({ address: request.address || "", coords: requestCoords });
		} else {
			setGeoData(undefined);
		}
	};

	const handleUpdate = async () => {
		if (isLoading) return;

		const updates: UpdateRequestInput = {
			title: getValue("title").trim(),
			description: getValue("description").trim(),
			address: geoData?.address,
			coords: geoData?.coords,
			priority: getValue("priority") as Priority,
			source: getValue("source").trim() || undefined,
			source_reference: getValue("sourceReference").trim() || undefined,
			requires_quote: getValue("requiresQuote"),
			estimated_value: getValue("estimatedValue")
				? parseFloat(getValue("estimatedValue"))
				: undefined,
		};

		const parseResult = UpdateRequestSchema.safeParse(updates);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			console.error("Validation errors:", parseResult.error);
			return;
		}

		setErrors(null);
		setSubmitError(null);
		setIsLoading(true);

		try {
			await updateRequest.mutateAsync({ id: request.id, data: parseResult.data });
			setIsLoading(false);
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to update request:", error);
			setSubmitError(
				errorMessage(error, "Failed to update request. Please try again.")
			);
			setIsLoading(false);
		}
	};

	const ErrorDisplay = useCallback(
		({ path }: { path: string }) => {
			if (!errors) return null;
			const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
			if (fieldErrors.length === 0) return null;
			return (
				<div className="mt-0.5">
					{fieldErrors.map((err, idx) => (
						<p
							key={idx}
							className="text-error-text text-xs leading-tight"
						>
							{err.message}
						</p>
					))}
				</div>
			);
		},
		[errors]
	);

	const isFormValid = useMemo(() => {
		return !!(
			getValue("title").trim() &&
			getValue("description").trim() &&
			getValue("priority")
		);
	}, [getValue]);

	const additionalPreviewTags = useMemo(() => {
		const tags: string[] = [];
		if (getValue("source").trim()) tags.push(getValue("source").trim());
		if (getValue("sourceReference").trim())
			tags.push(getValue("sourceReference").trim());
		if (getValue("requiresQuote")) tags.push("Req. Quote");
		if (getValue("estimatedValue")) tags.push(`$${getValue("estimatedValue")}`);
		return tags;
	}, [getValue]);

	const formContent = useMemo(
		() => (
			<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
				{/* Title */}
				<div className="min-w-0">
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Title *
					</label>
					<div className="relative">
						<input
							type="text"
							placeholder="Request Title"
							value={getValue("title")}
							onChange={(e) =>
								updateField("title", e.target.value)
							}
							className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
							disabled={isLoading}
						/>
						<UndoButton
							show={isDirty("title")}
							onUndo={() => undoField("title")}
							disabled={isLoading}
						/>
					</div>
					<ErrorDisplay path="title" />
				</div>

				{/* Client and Priority Row */}
				<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
							Client
						</label>
						<div className="border border-border px-2.5 pt-1.5 pb-1 w-full rounded bg-surface/50 text-text-tertiary text-sm">
							{request.client?.name || "Unknown Client"}
						</div>
						<p className="text-[10px] text-text-muted mt-0.5 leading-tight">
							Client cannot be changed
						</p>
					</div>

					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
							Priority
						</label>
						<div className="relative">
							<Dropdown
								entries={PRIORITY_ENTRIES}
								value={getValue("priority")}
								onChange={(newValue) =>
									updateField(
										"priority",
										newValue as Priority
									)
								}
								disabled={isLoading}
								error={errors?.issues.some(
									(e) =>
										e.path[0] ===
										"priority"
								)}
							/>
							<UndoButton
								show={isDirty("priority")}
								onUndo={() => undoField("priority")}
								position="right-9"
								disabled={isLoading}
							/>
						</div>
						<ErrorDisplay path="priority" />
					</div>
				</div>

				{/* Description */}
				<div className="min-w-0">
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Description *
					</label>
					<div className="relative">
						<textarea
							placeholder="Request Description"
							value={getValue("description")}
							onChange={(e) =>
								updateField(
									"description",
									e.target.value
								)
							}
							className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
							disabled={isLoading}
						/>
						<UndoButtonTop
							show={isDirty("description")}
							onUndo={() => undoField("description")}
							disabled={isLoading}
						/>
					</div>
					<ErrorDisplay path="description" />
				</div>

				{/* Address */}
				<div className="relative min-w-0" style={{ zIndex: 50 }}>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Address (Optional)
					</label>
					<div className="relative">
						<AddressForm
							mode={request.address ? "edit" : "create"}
							originalValue={request.address || ""}
							originalCoords={requestCoords}
							dropdownPosition="above"
							handleChange={handleChangeAddress}
							handleClear={handleClearAddress}
						/>
					</div>
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
						<span className="flex items-center gap-2 min-w-0 flex-1 mr-2">
							<span className="flex-shrink-0">
								Additional Optional Details
							</span>
							{!showAdditional &&
								additionalPreviewTags.length >
									0 && (
									<span className="flex items-center gap-1 min-w-0 overflow-hidden">
										{additionalPreviewTags.map(
											(
												tag,
												i
											) => (
												<span
													key={
														i
													}
													className="px-1.5 py-0.5 rounded bg-surface-raised text-text-secondary text-[10px] font-normal tracking-normal truncate max-w-[80px]"
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
							<ChevronUp
								size={14}
								className="flex-shrink-0"
							/>
						) : (
							<ChevronDown
								size={14}
								className="flex-shrink-0"
							/>
						)}
					</button>

					{showAdditional && (
						<div className="mt-2 space-y-2 lg:space-y-3 pl-0.5">
							{/* Source + Source Reference inline half-width */}
							<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
								<div className="min-w-0">
									<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
										Source
									</label>
									<div className="relative">
										<input
											type="text"
											placeholder="e.g., Phone Call"
											value={getValue(
												"source"
											)}
											onChange={(
												e
											) =>
												updateField(
													"source",
													e
														.target
														.value
												)
											}
											className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
											disabled={
												isLoading
											}
										/>
										<UndoButton
											show={isDirty(
												"source"
											)}
											onUndo={() =>
												undoField(
													"source"
												)
											}
											disabled={
												isLoading
											}
										/>
									</div>
								</div>

								{getValue("source").trim() ? (
									<div className="min-w-0">
										<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
											Source
											Reference
										</label>
										<div className="relative">
											<input
												type="text"
												placeholder="e.g., Ticket #12345"
												value={getValue(
													"sourceReference"
												)}
												onChange={(
													e
												) =>
													updateField(
														"sourceReference",
														e
															.target
															.value
													)
												}
												className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
												disabled={
													isLoading
												}
											/>
											<UndoButton
												show={isDirty(
													"sourceReference"
												)}
												onUndo={() =>
													undoField(
														"sourceReference"
													)
												}
												disabled={
													isLoading
												}
											/>
										</div>
									</div>
								) : (
									<div className="min-w-0" />
								)}
							</div>

							{/* Estimated Value (left) + Requires Quote (right) */}
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
											value={getValue(
												"estimatedValue"
											)}
											onChange={(
												e
											) =>
												updateField(
													"estimatedValue",
													e
														.target
														.value
												)
											}
											className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pl-7 pr-10 min-w-0"
											disabled={
												isLoading
											}
										/>
										<UndoButton
											show={isDirty(
												"estimatedValue"
											)}
											onUndo={() =>
												undoField(
													"estimatedValue"
												)
											}
											disabled={
												isLoading
											}
										/>
									</div>
								</div>

								<div className="flex items-end pb-1.5 lg:pb-2 min-w-0">
									<input
										type="checkbox"
										id="requires_quote"
										checked={getValue(
											"requiresQuote"
										)}
										onChange={(e) =>
											updateField(
												"requiresQuote",
												e
													.target
													.checked
											)
										}
										className="w-4 h-4 rounded border-border bg-base text-primary-hover focus:ring-primary focus:ring-2 cursor-pointer"
										disabled={isLoading}
									/>
									<label
										htmlFor="requires_quote"
										className="ml-2 text-xs lg:text-sm text-text-tertiary cursor-pointer"
									>
										Requires Quote
									</label>
									{isDirty(
										"requiresQuote"
									) && (
										<button
											type="button"
											title="Undo"
											onClick={() =>
												undoField(
													"requiresQuote"
												)
											}
											disabled={
												isLoading
											}
											className="ml-2 text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										>
											<RotateCcw
												size={
													14
												}
											/>
										</button>
									)}
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		),
		[
			getValue,
			updateField,
			undoField,
			isDirty,
			isLoading,
			errors,
			request,
			requestCoords,
			geoData,
			showAdditional,
			additionalPreviewTags,
			ErrorDisplay,
		]
	);

	return (
		<FormWizardContainer
			title="Edit Request"
			steps={[]}
			currentStep={1}
			visitedSteps={new Set([1])}
			isLoading={isLoading || updateRequest.isPending}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSubmit={handleUpdate}
			canGoNext={isFormValid}
			submitLabel="Save Changes"
			isEditMode={true}
		>
			<>
				<FormErrorBanner message={submitError} className="mb-2" />
				{formContent}
			</>
		</FormWizardContainer>
	);
}
