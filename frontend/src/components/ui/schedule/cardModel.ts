import { VisitStatusLabels, type VisitStatus } from "../../../types/jobs";
import type { OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";
import {
	getPriorityColor,
	hhmmToHours,
	occurrenceSpan,
	visitSpan,
	type CardSpan,
} from "./scheduleBoardUtils";
import { constraintChip, type ChipMode, type SnapshotTiming } from "./snapshotWhen";

export interface AssignedTech {
	id: string;
	name: string;
	color: string;
	inFilter: boolean;
}

export interface ConstraintView {
	chip: Record<ChipMode, string>;
	tone: "neutral" | "window";
	openEnded: boolean;
	/** Fractions (0–1) of the card span covered by a `between` window. */
	windowBand?: { from: number; to: number };
	/** Fraction (0–1) where a `by` deadline sits, only when it falls inside the card. */
	deadlineTick?: number;
}

export interface CardModel {
	kind: "visit" | "occurrence";
	fromPlan: boolean;
	title: string;
	subtitle?: string;
	client?: string;
	address?: string;
	status?: VisitStatus;
	ref?: string;
	description?: string;
	techs: AssignedTech[];
	priorityColor: string;
	constraint: ConstraintView;
	stockWarning?: "low" | "out";
	/** Occurrences have no crew; their Unassigned slot dims like an off-filter tech. */
	unassignedInFilter: boolean;
	ariaLabel: string;
}

export type CardEntry =
	| { kind: "visit"; visit: VisitWithJob }
	| { kind: "occurrence"; occurrence: OccurrenceWithPlan };

export interface CardModelCtx {
	techs: AssignedTech[];
	stockWarning?: "low" | "out";
	isAllSelected: boolean;
}

export function buildConstraintView(t: SnapshotTiming, span: CardSpan): ConstraintView {
	const view: ConstraintView = {
		chip: {
			column: constraintChip(t, "column"),
			inline: constraintChip(t, "inline"),
			sliver: constraintChip(t, "sliver"),
		},
		tone: t.arrival_constraint === "between" || t.arrival_constraint === "by" ? "window" : "neutral",
		openEnded: span.openEnded,
	};
	// Denominator matches the drawn minimum so fractions line up with the 28px floor.
	const denom = Math.max(span.endH - span.startH, 0.5);
	const frac = (h: number) => Math.min(1, Math.max(0, (h - span.startH) / denom));
	if (t.arrival_constraint === "between") {
		const a = hhmmToHours(t.arrival_window_start);
		const b = hhmmToHours(t.arrival_window_end);
		if (a !== null && b !== null) view.windowBand = { from: frac(a), to: frac(Math.max(a, b)) };
	} else if (t.arrival_constraint === "by") {
		const d = hhmmToHours(t.arrival_window_end);
		if (d !== null && d >= span.startH && d <= span.endH) view.deadlineTick = frac(d);
	}
	return view;
}

const mentions = (text: string | undefined, name: string) =>
	!!text && text.toLowerCase().includes(name.toLowerCase());

function dedupeClient(name: string | undefined, title: string, subtitle?: string) {
	const n = name?.trim();
	if (!n || mentions(title, n) || mentions(subtitle, n)) return undefined;
	return n;
}

function ariaLabelOf(m: Omit<CardModel, "ariaLabel">): string {
	const who = m.techs.length > 0 ? m.techs.map((t) => t.name).join(", ") : "Unassigned";
	const stock =
		m.stockWarning === "out" ? "Stock out" : m.stockWarning === "low" ? "Stock low" : null;
	return [
		m.kind === "occurrence" ? "Recurring" : null,
		m.title,
		m.subtitle,
		m.constraint.chip.column || null,
		m.status ? VisitStatusLabels[m.status] : null,
		m.client,
		m.address,
		m.ref,
		who,
		stock,
	]
		.filter(Boolean)
		.join(", ");
}

export function toCardModel(entry: CardEntry, ctx: CardModelCtx): CardModel {
	let model: Omit<CardModel, "ariaLabel">;
	if (entry.kind === "visit") {
		const v = entry.visit;
		const job = v.job_obj;
		const jobName = job?.name?.trim() ?? "";
		const title = v.name?.trim() || jobName || "Visit";
		const subtitle = jobName && jobName !== title ? jobName : undefined;
		const items = v.line_items?.length ?? 0;
		const ref = job?.job_number
			? items > 0
				? `${job.job_number} · ${items} ${items === 1 ? "item" : "items"}`
				: job.job_number
			: undefined;
		model = {
			kind: "visit",
			fromPlan: !!job?.recurring_plan,
			title,
			subtitle,
			client: dedupeClient(job?.client?.name, title, subtitle),
			address: job?.address?.trim() || undefined,
			status: v.status && v.status !== "Scheduled" ? v.status : undefined,
			ref,
			description: v.description?.trim() || job?.description?.trim() || undefined,
			techs: ctx.techs,
			priorityColor: getPriorityColor(job?.priority),
			constraint: buildConstraintView(
				{ ...v, start: v.scheduled_start_at, end: v.scheduled_end_at },
				visitSpan(v)
			),
			stockWarning: ctx.stockWarning,
			unassignedInFilter: ctx.isAllSelected,
		};
	} else {
		const o = entry.occurrence;
		const job = o.job_obj;
		const plan = o.plan;
		const title = job?.name?.trim() || plan?.name?.trim() || "Recurring visit";
		model = {
			kind: "occurrence",
			fromPlan: true,
			title,
			client: dedupeClient(plan?.client?.name ?? job?.client?.name, title),
			address: plan?.address?.trim() || job?.address?.trim() || undefined,
			ref: job?.job_number || undefined,
			description: plan?.description?.trim() || job?.description?.trim() || undefined,
			techs: [],
			priorityColor: getPriorityColor(job?.priority),
			constraint: buildConstraintView(
				{ ...o, start: o.occurrence_start_at, end: o.occurrence_end_at },
				occurrenceSpan(o)
			),
			unassignedInFilter: ctx.isAllSelected,
		};
	}
	return { ...model, ariaLabel: ariaLabelOf(model) };
}
