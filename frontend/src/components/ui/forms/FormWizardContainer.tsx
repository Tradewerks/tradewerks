import { ChevronLeft, ChevronRight, History, X, Save } from "lucide-react";
import FullPopup from "../FullPopup";
import StepWizard from "./StepWizard";
import type { FormStep } from "../../../types/common";

type SourceMode = "existing" | "draft";

interface FormWizardContainerProps<T extends number> {
	title: string;
	steps: FormStep<T>[];
	currentStep: T;
	visitedSteps: Set<T>;
	isLoading?: boolean;
	isOpen: boolean;
	onClose: () => void;
	canGoToStep?: (step: T) => boolean;
	onStepClick?: (step: T) => void;
	onNext?: () => void;
	onBack?: () => void;
	onSubmit?: () => void;
	/** False keeps Save disabled while the form still needs an answer. */
	canSubmit?: boolean;
	canGoNext?: boolean;
	submitLabel?: string;
	children: React.ReactNode;
	isEditMode?: boolean;
	fullHeightContent?: boolean;
	onStartFromExisting?: () => void;
	startFromExistingLabel?: string;
	hideStartFromExisting?: boolean;
	draftsOnly?: boolean; // when true, hides the Existing tab — shows "Drafts" label only
	hideSourceToggle?: boolean; // when true, no Existing/Drafts toggle while search is open (single-source search)
	isSourceSearchOpen?: boolean;
	onSourceModeChange?: (mode: SourceMode) => void;
	sourceMode?: SourceMode;
	draftCount?: number;
	onCloseSourceSearch?: () => void;
	onSaveDraft?: () => void;
	canSaveDraft?: boolean;
	isSavingDraft?: boolean;
}

export function FormWizardContainer<T extends number>({
	title,
	steps,
	currentStep,
	visitedSteps,
	isLoading = false,
	isOpen,
	onClose,
	canGoToStep,
	onStepClick,
	onNext,
	onBack,
	onSubmit,
	canSubmit = true,
	canGoNext,
	submitLabel,
	children,
	onStartFromExisting,
	startFromExistingLabel = "Start from Draft or Existing",
	hideStartFromExisting = false,
	draftsOnly = false,
	hideSourceToggle = false,
	fullHeightContent = false,
	isSourceSearchOpen = false,
	onSourceModeChange,
	sourceMode = "existing",
	draftCount = 0,
	onCloseSourceSearch,
	onSaveDraft,
	canSaveDraft = false,
	isSavingDraft = false,
}: FormWizardContainerProps<T>) {
	const isFirstStep = currentStep === (1 as T);
	const isLastStep = !steps.length || currentStep === steps[steps.length - 1]?.id;
	const stacked = steps.length >= 4;
	// When source search is open, always use inline layout (title + toggle side by side)
	const headerInline = !stacked || isSourceSearchOpen;

	const header = (
		<div
			className={`px-4 sm:px-5 pt-4 pb-3 flex-shrink-0 ${
				headerInline
					? "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3"
					: "space-y-2"
			}`}
		>
			<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap flex-shrink-0">
				{title}
			</h2>
			{isSourceSearchOpen
				? // When source search is open: only show toggle if both modes are available
					!draftsOnly && !hideSourceToggle && (
						<div className="flex-1 flex justify-center sm:max-w-[60%]">
							<div className="flex items-center bg-surface rounded-lg p-1 border border-border">
								<button
									type="button"
									onClick={() =>
										onSourceModeChange?.(
											"existing"
										)
									}
									className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
										sourceMode ===
										"existing"
											? "bg-surface-raised text-text-primary shadow-sm"
											: "text-text-tertiary hover:text-text-primary"
									}`}
								>
									Start from Existing
								</button>
								<button
									type="button"
									onClick={() =>
										onSourceModeChange?.(
											"draft"
										)
									}
									className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all ${
										sourceMode ===
										"draft"
											? "bg-surface-raised text-text-primary shadow-sm"
											: "text-text-tertiary hover:text-text-primary"
									}`}
								>
									Drafts
									{draftCount > 0 && (
										<span
											className={`px-1.5 py-0.5 text-[10px] rounded-full border ${
												sourceMode ===
												"draft"
													? "bg-warning/20 text-warning-text border-warning/30"
													: "bg-surface-raised text-text-tertiary border-border-strong"
											}`}
										>
											{draftCount}
										</span>
									)}
								</button>
							</div>
						</div>
					)
				: steps.length > 0 && (
						<div
							className={
								stacked
									? "w-full"
									: "flex-1 sm:max-w-[60%]"
							}
						>
							<StepWizard
								steps={steps}
								currentStep={currentStep}
								visitedSteps={visitedSteps}
								isLoading={isLoading}
								canGoToStep={canGoToStep}
								onStepClick={onStepClick}
								showNavigation={false}
							/>
						</div>
					)}
		</div>
	);

	// ── Shared button primitives ─────────────────────────────────────────
	// All buttons: same height, whitespace-nowrap prevents any mid-word breaks
	// Ghost — secondary actions
	const btnGhost =
		"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap flex-shrink-0";
	// Amber — Save Draft enabled
	const btnAmber =
		"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-warning-border bg-warning-bg text-sm font-medium text-warning-text hover:bg-warning-bg hover:border-warning-border hover:text-warning-text transition-colors whitespace-nowrap flex-shrink-0";
	// Muted — Save Draft disabled
	const btnMuted =
		"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle bg-transparent text-sm font-medium text-text-faint cursor-not-allowed whitespace-nowrap flex-shrink-0";
	// Primary blue — Next
	const btnPrimary =
		"inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-primary-hover hover:bg-primary disabled:bg-surface-raised disabled:text-text-muted text-sm font-semibold text-on-primary transition-colors disabled:cursor-not-allowed whitespace-nowrap flex-shrink-0";
	// Success — Submit
	const btnSuccess = (loading: boolean, blocked = false) =>
		`inline-flex items-center gap-1.5 h-8 px-4 rounded-md text-sm font-semibold text-on-primary transition-colors whitespace-nowrap flex-shrink-0 ${
			loading
				? "bg-confirm cursor-wait"
				: blocked
					? "bg-confirm opacity-40 cursor-not-allowed"
					: "bg-confirm hover:bg-confirm-hover"
		}`;

	// When Back is visible, the templates button collapses
	const showBack = !isSourceSearchOpen && !isFirstStep && !!onBack;
	const showTemplates =
		!isSourceSearchOpen && !!onStartFromExisting && !hideStartFromExisting;

	const footer = (
		<div className="flex-shrink-0 border-t border-border bg-base">
			<div className="flex items-center justify-between gap-2 px-4 py-2.5 min-w-0">
				<div className="flex items-center gap-2 min-w-0">
					{showBack && (
						<button
							type="button"
							onClick={onBack}
							disabled={isLoading}
							className={btnGhost}
						>
							<ChevronLeft size={15} />
							Back
						</button>
					)}

					{isSourceSearchOpen && onCloseSourceSearch ? (
						<button
							type="button"
							onClick={onCloseSourceSearch}
							disabled={isLoading}
							className={btnGhost}
						>
							<X size={14} />
							Cancel Search
						</button>
					) : showTemplates ? (
						<button
							type="button"
							onClick={onStartFromExisting}
							disabled={isLoading}
							title={
								showBack
									? startFromExistingLabel
									: undefined
							}
							className={btnGhost}
						>
							<History size={14} />
							{showBack
								? draftsOnly
									? "Draft"
									: "Existing / Draft"
								: startFromExistingLabel}
						</button>
					) : null}
				</div>

				<div className="flex items-center gap-2 flex-shrink-0">
					{!isSourceSearchOpen && onSaveDraft && (
						<>
							{isSavingDraft ? (
								<button
									type="button"
									disabled
									className={btnAmber}
								>
									<Save
										size={13}
										className="animate-pulse"
									/>
									Saving…
								</button>
							) : canSaveDraft && !isLoading ? (
								<button
									type="button"
									onClick={onSaveDraft}
									title="Save current form state as a draft"
									className={btnAmber}
								>
									<Save size={13} />
									Save Draft
								</button>
							) : (
								<button
									type="button"
									disabled
									title="Add some content before saving a draft"
									className={btnMuted}
								>
									<Save size={13} />
									Save Draft
								</button>
							)}
							<div className="w-px h-5 bg-surface-raised flex-shrink-0" />
						</>
					)}

					<button
						type="button"
						onClick={onClose}
						disabled={isLoading}
						className={btnGhost}
					>
						Cancel
					</button>

					{!isSourceSearchOpen &&
						(!isLastStep && onNext ? (
							<button
								type="button"
								onClick={onNext}
								disabled={!canGoNext || isLoading}
								className={btnPrimary}
							>
								Next
								<ChevronRight size={15} />
							</button>
						) : onSubmit ? (
							<button
								type="button"
								onClick={onSubmit}
								disabled={isLoading || !canSubmit}
								className={btnSuccess(isLoading, !canSubmit)}
							>
								{isLoading
									? "Processing…"
									: submitLabel || "Submit"}
							</button>
						) : null)}
				</div>
			</div>
		</div>
	);

	return (
		<FullPopup
			isModalOpen={isOpen}
			onClose={onClose}
			content={
				<div className="flex flex-col min-h-0 flex-1">
					{header}
					<div className="border-t border-border mx-4 flex-shrink-0" />
					<div
						className={`flex-1 min-h-0 ${
							fullHeightContent
								? "flex flex-col"
								: "overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
						}`}
					>
						{fullHeightContent ? (
							<div className="px-4 sm:px-5 pt-3 sm:pt-4 flex flex-col min-h-0">
								{children}
							</div>
						) : (
							<div className="px-4 pt-3 sm:px-5 sm:pt-4 pb-4">
								{children}
							</div>
						)}
					</div>
					{footer}
				</div>
			}
		/>
	);
}
