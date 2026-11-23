import { Check, Lock, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FormStep } from "../../../types/common";

export interface StepWizardProps<T extends number> {
	steps: FormStep<T>[];
	currentStep: T;
	visitedSteps: Set<T>;
	isLoading?: boolean;
	canGoToStep?: (step: T) => boolean;
	onStepClick?: (step: T) => void;
	onNext?: () => void;
	onBack?: () => void;
	onCancel?: () => void;
	onSubmit?: () => void;
	canGoNext?: boolean;
	submitLabel?: string;
	cancelLabel?: string;
	nextLabel?: string;
	backLabel?: string;
	showNavigation?: boolean;
	children?: React.ReactNode;
}

const StepWizard = <T extends number>({
	steps,
	currentStep,
	visitedSteps,
	isLoading = false,
	canGoToStep = () => true,
	onStepClick,
	onNext,
	onBack,
	onCancel,
	onSubmit,
	canGoNext = true,
	submitLabel: submitLabelProp,
	cancelLabel: cancelLabelProp,
	nextLabel: nextLabelProp,
	backLabel: backLabelProp,
	showNavigation = true,
	children,
}: StepWizardProps<T>) => {
	const { t } = useTranslation();
	const submitLabel = submitLabelProp ?? t("wizard.submit");
	const cancelLabel = cancelLabelProp ?? t("common.cancel");
	const nextLabel = nextLabelProp ?? t("wizard.next");
	const backLabel = backLabelProp ?? t("wizard.back");
	const isFirstStep = currentStep === (1 as T);
	const isLastStep = currentStep === steps[steps.length - 1]?.id;

	const stepStates = useMemo(() => {
		return steps.map((step, index) => {
			const isCurrent = currentStep === step.id;
			// Completed (green) = positionally before the current step.
			// Pending (yellow) = ahead of the current step but already
			// visited/filled — only reachable by navigating backward, and
			// signals "this step has content" distinctly from a step that's
			// accessible-but-untouched.
			const isCompleted = currentStep > step.id;
			const isAccessible = canGoToStep(step.id);
			const isLocked = !isAccessible && !isCompleted;
			const isPending =
				visitedSteps.has(step.id) && step.id > currentStep && !isCompleted;

			return {
				...step,
				isCurrent,
				isCompleted,
				isAccessible,
				isLocked,
				isPending,
				isLast: index === steps.length - 1,
			};
		});
	}, [steps, currentStep, visitedSteps, canGoToStep]);

	const getStepStyles = (state: (typeof stepStates)[0]) => {
		if (state.isCurrent)
			return "bg-primary-hover border-primary text-on-primary shadow-lg shadow-primary-bg";
		if (state.isCompleted)
			return "bg-confirm border-confirm text-on-primary hover:bg-confirm-hover";
		if (state.isPending)
			return "bg-warning border-warning-border text-on-primary hover:bg-warning font-bold";
		if (state.isAccessible && !state.isCompleted && !state.isCurrent)
			return "bg-base border-border-subtle text-text-faint hover:bg-surface hover:text-text-tertiary";
		return "bg-base border-border-subtle text-text-faint";
	};

	const getLabelColor = (state: (typeof stepStates)[0]) => {
		if (state.isCurrent) return "text-primary-text";
		if (state.isCompleted) return "text-success-text";
		if (state.isPending) return "text-warning-text";
		return "text-text-faint";
	};

	const getLineColor = (index: number) => {
		if (index >= steps.length - 1) return "";
		const nextState = stepStates[index + 1];
		if (!nextState) return "bg-border-subtle";
		if (nextState.isCompleted) return "bg-confirm";
		if (nextState.isCurrent) return "bg-primary-hover";
		if (nextState.isPending) return "bg-warning";
		return "bg-border-subtle";
	};

	const getCursorStyle = (state: (typeof stepStates)[0]) => {
		if (isLoading) return "cursor-not-allowed";
		if (state.isLocked) return "cursor-not-allowed";
		if (state.isCurrent) return "cursor-default";
		if (state.isAccessible) return "cursor-pointer";
		return "cursor-not-allowed";
	};

	return (
		<div className="w-full flex flex-col h-full">
			{/* Progress Indicator */}
			<div className="w-full">
				<div className="flex items-center justify-center">
					{stepStates.map((state, index) => (
						<div
							key={state.id}
							className="flex items-center justify-center flex-initial"
						>
							<div className="flex flex-col items-center flex-shrink-0">
								<button
									type="button"
									onClick={() =>
										!state.isLocked &&
										onStepClick?.(
											state.id
										)
									}
									disabled={
										state.isLocked ||
										isLoading
									}
									className={`
										flex items-center justify-center w-9 h-9 rounded-full text-sm font-semibold 
										transition-all duration-300 border-2 flex-shrink-0
										${getStepStyles(state)}
										${getCursorStyle(state)}
										${(state.isLocked || isLoading) && "opacity-50"}
									`}
								>
									{state.isCompleted ? (
										<Check
											size={16}
											strokeWidth={
												3
											}
										/>
									) : state.isLocked ? (
										<Lock size={12} />
									) : (
										state.id
									)}
								</button>
								<span
									className={`
										mt-2 text-xs font-medium transition-colors duration-300
										max-w-[112px] leading-tight text-center
										${getLabelColor(state)}
									`}
									title={state.label}
								>
									{state.label}
								</span>
							</div>

							{!state.isLast && (
								<div className="flex-1 h-0.5 mx-4 mb-6 min-w-[2rem]">
									<div
										className={`h-full w-full ${getLineColor(index)} transition-colors duration-500`}
									/>
								</div>
							)}
						</div>
					))}
				</div>
			</div>

			{/* Content Area  */}
			{children && (
				<div className="flex-1 overflow-y-auto">
					{children}
				</div>
			)}

			{/* Navigation Footer */}
			{showNavigation && (
				<div className="flex items-center justify-between border-t border-border bg-base/50">
					<div>
						{!isFirstStep && onBack && (
							<button
								type="button"
								onClick={onBack}
								disabled={isLoading}
								className="flex items-center gap-1 px-4 py-2 text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors disabled:opacity-50"
							>
								<ChevronLeft size={18} />
								{backLabel}
							</button>
						)}
					</div>

					<div className="flex items-center gap-2">
						{onCancel && (
							<button
								type="button"
								onClick={onCancel}
								disabled={isLoading}
								className="px-4 py-2 text-text-tertiary hover:text-text-primary hover:bg-surface rounded-md transition-colors disabled:opacity-50"
							>
								{cancelLabel}
							</button>
						)}

						{!isLastStep && onNext ? (
							<button
								type="button"
								onClick={onNext}
								disabled={!canGoNext || isLoading}
								className="flex items-center gap-1 px-5 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-surface-raised disabled:text-text-tertiary text-on-primary rounded-md font-medium transition-colors"
							>
								{nextLabel}
								<ChevronRight size={18} />
							</button>
						) : onSubmit ? (
							<button
								type="button"
								onClick={onSubmit}
								disabled={isLoading}
								className={`
									flex items-center gap-2 px-5 py-2 rounded-md font-bold transition-colors
									${isLoading ? "bg-confirm text-on-primary cursor-wait" : "bg-confirm hover:bg-confirm-hover text-on-primary"}
								`}
							>
								{isLoading ? (
									<>
										<Loader2
											size={16}
											className="animate-spin"
										/>
										Processing...
									</>
								) : (
									submitLabel
								)}
							</button>
						) : null}
					</div>
				</div>
			)}
		</div>
	);
};

export default StepWizard;
