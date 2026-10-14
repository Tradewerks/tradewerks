import { useId } from "react";
import { Check, CircleDot } from "lucide-react";
import { splitActions } from "./overflow";
import type { LifecycleAction, LifecycleStage } from "./types";

const INTENT_CLASSES: Record<LifecycleAction["intent"], string> = {
	primary: "bg-primary-hover hover:bg-primary text-on-primary",
	neutral: "bg-surface hover:bg-surface-raised border border-border text-text-secondary",
	warning: "bg-surface hover:bg-surface-raised border border-warning-border text-warning-text",
	destructive: "bg-surface hover:bg-surface-raised border border-border text-error-text",
};

interface LifecycleBarProps {
	/**
	 * `state` for an entity whose statuses are modes rather than a march — a
	 * recurring plan sits in Active for years and Paused is a return trip, so a
	 * stepper would draw a permanently-full two-step bar. On the normal stage
	 * such a bar renders only its actions; the header's pill names the mode.
	 */
	variant?: "stepper" | "state";
	/** The happy path, in order. Owned by each entity's actions module. */
	steps?: readonly string[];
	/** Status value → display label, so the bar never prints enum spellings. */
	stepLabels?: Record<string, string>;
	/**
	 * Overrides the stage's default tone. A terminal stage isn't automatically
	 * bad news — a completed plan and a cancelled one share it — and only the
	 * page knows which it has.
	 */
	tone?: "neutral" | "warning" | "error";
	/**
	 * The entity is off the happy path, so the track renders muted with nothing
	 * claimed: the bar isn't told which step was last reached, and a guess would
	 * read as fact.
	 */
	offRamp?: { label: string; note?: React.ReactNode };
	stage: LifecycleStage;
	currentStatus: string;
	/**
	 * The full action list. The bar renders only the inline share of it; the
	 * rest belongs to the page header's kebab, which calls the same
	 * splitActions() to learn what that share is.
	 */
	actions: LifecycleAction[];
	/** Dispute and terminal stages render their own content here, in place of the stepper. */
	detail?: React.ReactNode;
	/**
	 * Whether the bar draws the step track. A page that promotes the track
	 * elsewhere (Request renders it as LifecycleRule above the tab strip) passes
	 * false, leaving the bar only the off-ramp chip and the terminal reason.
	 */
	track?: boolean;
}

/**
 * Disabled is carried by muted chrome and a muted text token, never opacity:
 * `opacity-40` over `text-text-muted` measures ~1.7:1 in the light theme.
 * aria-disabled, not the disabled attribute, so the button stays focusable and
 * its reason reachable; the click guard is what stops the action.
 */
const DISABLED_CLASSES =
	"border border-border-subtle bg-transparent text-text-muted cursor-not-allowed";

function ActionButton({ action, reasonId }: { action: LifecycleAction; reasonId?: string }) {
	const blocked = Boolean(action.disabled);
	return (
		<button
			type="button"
			onClick={blocked ? undefined : action.onSelect}
			aria-disabled={blocked || undefined}
			aria-describedby={blocked && action.disabledReason ? reasonId : undefined}
			className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
				blocked ? DISABLED_CLASSES : INTENT_CLASSES[action.intent]
			}`}
		>
			{action.label}
		</button>
	);
}

const TONE_CLASSES = {
	neutral: "border-border-strong bg-surface",
	warning: "border-warning-border bg-warning-bg",
	error: "border-error-border bg-error-bg",
} as const;

type StepState = "done" | "current" | "later";

const LABEL_CLASSES: Record<StepState, string> = {
	done: "text-text-tertiary",
	current: "font-semibold text-text-primary",
	later: "text-text-muted",
};

// Card density stacks a segment under each label, so its fill is keyed on the
// step's own state rather than on a move between two steps.
const SEGMENT_CLASSES: Record<StepState, string> = {
	done: "bg-primary",
	current: "bg-primary",
	later: "bg-border-subtle",
};

// Rule density only: at 3px tall border-subtle vanishes on the light themes,
// taking the un-reached part of the track with it.
const CONNECTOR_EMPTY = "bg-border";

function StepTrack({
	path,
	currentStatus,
	offRamp,
	labelFor,
	density = "card",
	tone = "default",
	halted = false,
}: {
	path: readonly string[];
	currentStatus: string;
	offRamp: boolean;
	labelFor: (step: string) => string;
	/**
	 * "rule" is the compact variant fused to the tab strip: no width cap, and
	 * smaller type and segments so it reads as chrome, not a second headline.
	 */
	density?: "card" | "rule";
	tone?: "default" | "warning";
	/** The lit step is where the run stopped, not where the document is now. */
	halted?: boolean;
}) {
	const currentIndex = path.indexOf(currentStatus);
	// A halted run keeps the shape but takes the warning tone, so it doesn't
	// look like ordinary progress.
	const fill = tone === "warning" ? "bg-warning" : "bg-primary";
	const markerTone = tone === "warning" ? "text-warning-text" : "text-primary-text";

	return (
		<ol
			className={`flex w-full min-w-0 ${
				density === "card" ? "max-w-xl gap-[3px]" : "gap-3"
			}`}
		>
			{path.map((step, index) => {
				// currentIndex is -1 off the path, so nothing is marked done:
				// an off-ramp has no position to claim.
				const isCurrent = !offRamp && step === currentStatus;
				// Doubles as the rule connector's fill. A connector spans the
				// move from this step to the next, and only moves already made
				// are lit — so the one after the current step stays empty,
				// where coloured it read as though the next status were live.
				const isDone = !offRamp && currentIndex >= 0 && index < currentIndex;
				const state: StepState = isCurrent ? "current" : isDone ? "done" : "later";
				const isLast = index === path.length - 1;

				return (
					<li
						key={step}
						data-step-state={state}
						aria-label={
							// A halted rail lights where the run stopped, not
							// the current status — announcing it as "Current
							// status" would contradict the page's pill.
							// aria-current stays: it is still the position.
							isCurrent
								? `${halted ? "Stopped at" : "Current status"}: ${labelFor(step)}`
								: undefined
						}
						aria-current={isCurrent ? "step" : undefined}
						className={`flex min-w-0 ${
							density === "card"
								? "flex-1 flex-col gap-1.5"
								: // The run ends on the final label, so the last
									// step takes only the width it needs. Below
									// sm only the current step is named, so an
									// equal share clipped its label.
									`items-center gap-2 ${isLast ? "flex-none" : "flex-1"} ${
										isCurrent ? "max-sm:flex-auto" : ""
									}`
						}`}
					>
						<span
							className={`flex h-4 min-w-0 items-center gap-1 font-medium ${
								density === "card"
									? "text-xs"
									: `flex-shrink ${isCurrent ? "text-xs" : "text-[11px]"}`
							} ${LABEL_CLASSES[state]}`}
						>
							{/* Green reads as settled; the blue track is the run
							    itself, so the two carry different jobs. */}
							{state === "done" && (
								<Check
									aria-hidden="true"
									size={12}
									strokeWidth={2.5}
									className="flex-shrink-0 text-success-text"
								/>
							)}
							{/* Weight and brightness alone did not separate the
							    current step from its neighbours at a glance.
							    Same family, size and stroke as the check, so the
							    glyph column reads as one set rather than as a
							    drawn icon beside a bullet. */}
							{isCurrent && (
								<CircleDot
									aria-hidden="true"
									size={12}
									strokeWidth={2.5}
									className={`flex-shrink-0 ${markerTone}`}
								/>
							)}
							{/* At phone width only the current step is named; the
							    segments still carry the position. */}
							<span
								className={`truncate ${state === "current" ? "" : "max-sm:sr-only"}`}
							>
								{labelFor(step)}
							</span>
						</span>
						{density === "card" ? (
							<span
								aria-hidden="true"
								className={`h-1 rounded-full transition-colors duration-200 ease-out ${SEGMENT_CLASSES[state]}`}
							/>
						) : (
							!isLast && (
								<span
									aria-hidden="true"
									className={`h-[3px] min-w-3 flex-1 rounded-full transition-colors duration-200 ease-out ${
										isDone ? fill : CONNECTOR_EMPTY
									}`}
								/>
							)
						)}
					</li>
				);
			})}
		</ol>
	);
}

/**
 * The one surface carrying a document's lifecycle, present in every state so
 * opening a dispute and resolving one occupy the same space.
 *
 * It has no menu of its own — lifecycle overflow is a labeled group in the
 * header's single kebab (see DetailHeader) — and is purely presentational:
 * every gating decision arrives already made in `actions`.
 */
export default function LifecycleBar({
	variant = "stepper",
	steps,
	stepLabels,
	tone,
	offRamp,
	stage,
	currentStatus,
	actions,
	detail,
	track = true,
}: LifecycleBarProps) {
	// Derived, not a prop: offRamp already says "off the happy path", and a
	// second prop saying it could disagree.
	const { inline } = splitActions(stage, actions, { offRamp: Boolean(offRamp) });
	const uid = useId();
	const reasonId = (id: string) => `${uid}-reason-${id}`;

	const labelFor = (step: string) => stepLabels?.[step] ?? step;
	const actionsOnly = stage === "normal" && variant === "state";

	if (actionsOnly && inline.length === 0) return null;
	// Nothing left to draw once the track is promoted away; an empty bordered
	// box is worse than no bar.
	if (!track && stage === "normal" && !offRamp && inline.length === 0) return null;

	const toneClass = tone
		? TONE_CLASSES[tone]
		: stage === "dispute"
			? TONE_CLASSES.warning
			: stage === "terminal"
				? TONE_CLASSES.neutral
				: "border-border-subtle bg-surface/50";

	return (
		<div
			className={`flex flex-wrap justify-between gap-x-6 gap-y-3 rounded-lg border px-4 py-3 ${
				stage === "normal" ? "items-center" : "items-start"
			} ${toneClass}`}
		>
			{actionsOnly ? (
				<span aria-label={`Current status: ${labelFor(currentStatus)}`} className="sr-only">
					{labelFor(currentStatus)}
				</span>
			) : (
				// Full row below sm: sharing it with the buttons squeezed the
				// segments until the one visible label truncated.
				<div className="min-w-0 flex-1 max-sm:basis-full">
					{stage !== "normal" ? (
						detail
					) : (
						<div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
							{offRamp && (
								<span className="flex flex-col">
									<span
										aria-label={`Current status: ${offRamp.label}`}
										className="inline-flex items-center rounded-md border border-warning-border bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-text"
									>
										{offRamp.label}
									</span>
									{offRamp.note && (
										<span className="mt-0.5 text-xs text-text-tertiary">
											{offRamp.note}
										</span>
									)}
								</span>
							)}
							{track && (
								<StepTrack
									path={steps ?? []}
									currentStatus={currentStatus}
									offRamp={Boolean(offRamp)}
									labelFor={labelFor}
								/>
							)}
						</div>
					)}
				</div>
			)}

			{inline.length > 0 && (
				<div
					className={`flex min-w-0 flex-wrap items-center gap-2 ${actionsOnly ? "ml-auto" : ""}`}
				>
					{inline.map((action) => (
						<ActionButton
							key={action.id}
							action={action}
							reasonId={reasonId(action.id)}
						/>
					))}
					{/* Screen-reader only. Printed under the buttons, every
					    reason restated what the dead button already showed. */}
					{inline.map(
						(action) =>
							action.disabled &&
							action.disabledReason && (
								<span
									key={`reason-${action.id}`}
									id={reasonId(action.id)}
									className="sr-only"
								>
									{action.disabledReason}
								</span>
							)
					)}
				</div>
			)}
		</div>
	);
}

/**
 * The step track on its own, sized to sit as the top edge of the tab strip,
 * since position and "which view am I reading" are one question. It carries no
 * status word — the header pill owns that — and off the happy path it renders
 * muted with nothing claimed.
 */
export function LifecycleRule({
	steps,
	stepLabels,
	currentStatus,
	offRamp = false,
	haltedAt = null,
	tone = "default",
}: {
	steps: readonly string[];
	stepLabels?: Record<string, string>;
	currentStatus: string;
	offRamp?: boolean;
	/**
	 * Where the run stopped, for a status not itself on the path (a dispute's
	 * status_at_open). Typed `string` upstream, so a value the path doesn't
	 * contain is ignored rather than trusted.
	 */
	haltedAt?: string | null;
	tone?: "default" | "warning";
}) {
	const onPath = steps.includes(currentStatus);
	const halted = !onPath && haltedAt !== null && steps.includes(haltedAt);

	return (
		<StepTrack
			path={steps}
			currentStatus={halted ? haltedAt : currentStatus}
			offRamp={offRamp}
			labelFor={(step) => stepLabels?.[step] ?? step}
			density="rule"
			tone={tone}
			halted={halted}
		/>
	);
}

/**
 * The inline lifecycle buttons, for a page that renders them in the header
 * rather than the bar. Same ActionButton, so the two placements can't drift;
 * the caller still gets `inline` from splitActions.
 */
export function LifecycleActions({ actions }: { actions: LifecycleAction[] }) {
	const uid = useId();
	if (actions.length === 0) return null;
	return (
		<>
			{actions.map((action) => (
				<ActionButton
					key={action.id}
					action={action}
					reasonId={`${uid}-reason-${action.id}`}
				/>
			))}
			{actions.map(
				(action) =>
					action.disabled &&
					action.disabledReason && (
						<span
							key={`reason-${action.id}`}
							id={`${uid}-reason-${action.id}`}
							className="sr-only"
						>
							{action.disabledReason}
						</span>
					)
			)}
		</>
	);
}
