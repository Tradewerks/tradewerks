import { useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Card from "../../ui/Card";
import { useJobVisitsByTechIdQuery } from "../../../hooks/useJobs";
import {
	VisitStatusColors,
	VisitStatusLabels,
	type JobVisit,
	type VisitStatus,
} from "../../../types/jobs";
import { NAV_BUTTON, NAV_BUTTON_SM } from "./navButtons";
import type { Technician } from "../../../types/technicians";
import { partitionVisits, type ScheduleSegment } from "../technicianSchedule";
import { formatTime } from "../technicianFormat";

const PAGE = 25;
// Hints restate partitionVisits' rules; the segments aren't plain date ranges
// (an in-progress visit from yesterday is "Today", a cancelled future one is "Past").
const SEGMENTS: { id: ScheduleSegment; label: string; empty: string; hint: string }[] = [
	{
		id: "upcoming",
		label: "Upcoming",
		empty: "No upcoming visits.",
		hint: "Scheduled from tomorrow on. Cancelled visits are under Past.",
	},
	{
		id: "today",
		label: "Today",
		empty: "No visits today.",
		hint: "Scheduled today, plus any visit still in progress.",
	},
	{
		id: "past",
		label: "Past",
		empty: "No past visits.",
		hint: "Earlier visits, plus every cancelled visit.",
	},
];

const fmtDate = (d: Date | string) =>
	new Date(d).toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});

// First/last cells carry the horizontal inset so the hover band has breathing
// room inside the card instead of butting the text against its edges.
// The band is painted per cell (rounded at the ends), which needs a separated
// border model — so the row divider lives on the cells too.
const CELL =
	"border-b border-border-subtle/60 py-2.5 pr-3 transition-colors duration-150 ease-out first:rounded-l-lg first:pl-3 last:rounded-r-lg last:pr-3 group-last:border-b-0 group-hover:bg-surface-raised group-focus-within:bg-surface-raised";
const HEAD = "border-b border-border-subtle py-2 pr-3 font-semibold first:pl-3 last:pr-3";

// Fixed widths so the job name, the one column that must be read, gets the slack
// rather than the time window.
const COLUMNS: { label: string; className: string; srOnly?: boolean }[] = [
	{ label: "Date", className: "w-32" },
	{ label: "Window", className: "w-44" },
	{ label: "Job · Client", className: "" },
	{ label: "Address", className: "hidden w-[26%] lg:table-cell" },
	{ label: "Status", className: "w-28" },
	{ label: "Crew", className: "w-12", srOnly: true },
];

/**
 * The whole row opens the visit. The job link stays the keyboard/tab stop (and
 * keeps middle-click / open-in-new-tab); the row click is the mouse shortcut,
 * so it steps aside for clicks on the link itself and for text selection.
 */
function ScheduleRow({ visit: v }: { visit: JobVisit }) {
	const navigate = useNavigate();
	const href = `/dispatch/jobs/${v.job_id}/visits/${v.id}`;
	const crew = v.visit_techs?.length ?? 1;
	const others = crew - 1;
	const jobLabel = [v.job?.name ?? "Visit", v.job?.client?.name].filter(Boolean).join(" · ");

	const onRowClick = (e: MouseEvent<HTMLTableRowElement>) => {
		if ((e.target as HTMLElement).closest("a")) return;
		if (window.getSelection()?.toString()) return;
		if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
		else navigate(href);
	};

	return (
		<tr onClick={onRowClick} className="group cursor-pointer">
			<td className={`${CELL} whitespace-nowrap tabular-nums`}>
				{fmtDate(v.scheduled_start_at)}
			</td>
			<td
				className={`${CELL} whitespace-nowrap tabular-nums text-text-secondary`}
			>
				{formatTime(v.scheduled_start_at)} –{" "}
				{formatTime(v.scheduled_end_at)}
				{v.actual_start_at && (
					<span className="block text-xs text-text-muted">
						Actual {formatTime(v.actual_start_at)}
						{v.actual_end_at
							? ` – ${formatTime(v.actual_end_at)}`
							: " (ongoing)"}
					</span>
				)}
			</td>
			<td className={`${CELL} max-w-0`}>
				<Link
					to={href}
					title={jobLabel}
					className="block truncate font-medium text-text-primary outline-none transition-colors duration-150 ease-out group-hover:text-primary-text group-focus-within:text-primary-text"
				>
					{v.job?.name ?? "Visit"}
					{v.job?.client?.name && (
						<span className="font-normal text-text-tertiary">
							{" "}
							· {v.job.client.name}
						</span>
					)}
				</Link>
			</td>
			<td
				className={`${CELL} hidden max-w-0 truncate text-text-tertiary lg:table-cell`}
			>
				{v.job?.address}
			</td>
			<td className={CELL}>
				<span
					className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${VisitStatusColors[v.status as VisitStatus] ?? ""}`}
				>
					{VisitStatusLabels[v.status as VisitStatus] ?? v.status}
				</span>
			</td>
			<td className={`${CELL} text-right text-xs tabular-nums text-text-muted`}>
				{others > 0 && (
					<span title={`${crew} technicians on this visit`}>
						<span aria-hidden>+{others}</span>
						<span className="sr-only">
							{others} other{" "}
							{others === 1
								? "technician"
								: "technicians"}
						</span>
					</span>
				)}
			</td>
		</tr>
	);
}

export default function TechnicianScheduleTab({ technician }: { technician: Technician }) {
	const { data, isLoading, isError, refetch } = useJobVisitsByTechIdQuery(technician.id);
	const [segment, setSegment] = useState<ScheduleSegment>("upcoming");
	const [shown, setShown] = useState(PAGE);
	const radios = useRef<(HTMLButtonElement | null)[]>([]);
	const parts = useMemo(() => partitionVisits(data ?? [], new Date()), [data]);
	const rows = parts[segment];
	const active = SEGMENTS.find((s) => s.id === segment)!;
	const hintId = useId();

	const select = (id: ScheduleSegment) => {
		setSegment(id);
		setShown(PAGE);
	};

	return (
		<div
			role="tabpanel"
			id="tabpanel-schedule"
			aria-labelledby="tab-schedule"
			className="mt-6 space-y-4"
		>
			<h2 className="sr-only">Schedule</h2>
			<Card title="Visits">
				<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<div
						role="radiogroup"
						aria-label="Visit range"
						aria-describedby={hintId}
						className="inline-flex rounded-lg border border-border p-0.5"
					>
						{SEGMENTS.map((s, i) => (
							<button
								key={s.id}
								ref={(el) => {
									radios.current[i] = el;
								}}
								type="button"
								role="radio"
								aria-checked={segment === s.id}
								tabIndex={segment === s.id ? 0 : -1}
								onClick={() => select(s.id)}
								onKeyDown={(e) => {
									const last =
										SEGMENTS.length - 1;
									let nextIndex:
										| number
										| null = null;
									if (
										e.key ===
											"ArrowRight" ||
										e.key ===
											"ArrowDown"
									)
										nextIndex =
											i === last
												? 0
												: i +
													1;
									else if (
										e.key ===
											"ArrowLeft" ||
										e.key === "ArrowUp"
									)
										nextIndex =
											i === 0
												? last
												: i -
													1;
									else if (e.key === "Home")
										nextIndex = 0;
									else if (e.key === "End")
										nextIndex = last;
									if (nextIndex === null)
										return;
									e.preventDefault();
									select(
										SEGMENTS[nextIndex]
											.id
									);
									radios.current[
										nextIndex
									]?.focus();
								}}
								className={`rounded-md px-3 py-1 text-sm transition-colors duration-150 ease-out ${
									segment === s.id
										? "bg-surface-raised text-text-primary"
										: "text-text-tertiary hover:text-text-primary"
								}`}
							>
								{s.label}
								<span className="ml-1.5 tabular-nums text-text-muted">
									{parts[s.id].length}
								</span>
							</button>
						))}
					</div>
					<p id={hintId} className="text-xs text-text-muted">
						{active.hint}
					</p>
				</div>

				{isLoading ? (
					<div className="space-y-2">
						{Array.from({ length: 5 }, (_, i) => (
							<div
								key={i}
								className="h-10 animate-pulse rounded bg-surface"
							/>
						))}
					</div>
				) : isError ? (
					<div className="flex items-center gap-3 text-sm">
						<span className="text-error-text">
							Couldn't load visits.
						</span>
						<button
							type="button"
							onClick={() => refetch()}
							className={NAV_BUTTON_SM}
						>
							Retry
						</button>
					</div>
				) : rows.length === 0 ? (
					<p className="py-8 text-center text-sm text-text-muted">
						{active.empty}
					</p>
				) : (
					<>
						{/* Pulled out by the cells' inset so the text lines up with the
						    range control while the row highlight bleeds into the card padding. */}
						<div className="-mx-3">
							<table className="w-full table-fixed border-separate border-spacing-0 text-sm">
								<thead>
									<tr className="text-left text-xs uppercase tracking-wide text-text-muted">
										{COLUMNS.map(
											(c) => (
												<th
													key={
														c.label
													}
													className={`${HEAD} ${c.className}`}
												>
													{c.srOnly ? (
														<span className="sr-only">
															{
																c.label
															}
														</span>
													) : (
														c.label
													)}
												</th>
											)
										)}
									</tr>
								</thead>
								<tbody>
									{rows
										.slice(0, shown)
										.map((v) => (
											<ScheduleRow
												key={
													v.id
												}
												visit={
													v
												}
											/>
										))}
								</tbody>
							</table>
						</div>
						{rows.length > shown && (
							<button
								type="button"
								onClick={() =>
									setShown((n) => n + PAGE)
								}
								className={`${NAV_BUTTON} mt-3 self-start`}
							>
								Show more ({rows.length - shown}{" "}
								remaining)
							</button>
						)}
					</>
				)}
			</Card>
		</div>
	);
}
