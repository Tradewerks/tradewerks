import { useState } from "react";
import { STATUS_PILLS, type BoardStatus, type VisitStatus } from "./visitDemo";

type Approval = "pending" | "approved" | "declined";

const NAV = [
	"Dashboard",
	"Schedule",
	"Requests",
	"Quotes",
	"Jobs",
	"Projects",
	"Invoices",
	"Clients",
	"Inventory",
	"Purchases",
	"Vehicles",
	"Technicians",
	"Map",
	"Insights",
	"Followups",
];

// Four columns once the board has room; below that each row stacks as
// time + status over the visit, then the tech (a container query, since the
// board's width depends on whether the assistant panel wraps beside it).
const wideGrid =
	"@min-[520px]:grid-cols-[78px_minmax(0,1.7fr)_minmax(0,1fr)_108px] @min-[520px]:gap-y-0 @min-[520px]:[grid-template-areas:'time_visit_tech_status']";

interface BoardRow {
	time: string;
	visit: string;
	client: string;
	tech: string;
	status: BoardStatus;
	highlight?: boolean;
}

function Board({ rows }: { rows: BoardRow[] }) {
	return (
		<div className="@container overflow-hidden rounded-[10px] border border-line">
			<div
				className={`hidden gap-3 border-b border-line-soft bg-paper-2 px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-2 @min-[520px]:grid ${wideGrid}`}
			>
				<div>Start</div>
				<div>Visit</div>
				<div>Tech</div>
				<div>Status</div>
			</div>
			<div className="divide-y divide-line-soft">
				{rows.map((row) => {
					const pill = STATUS_PILLS[row.status];
					const unassigned = row.tech === "Unassigned";
					return (
						<div
							key={row.visit}
							className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3.5 py-[13px] text-sm transition-colors [grid-template-areas:'time_status'_'visit_visit'_'tech_tech'] ${wideGrid} ${row.highlight ? "bg-highlight" : "bg-white"}`}
						>
							<div className="font-mono text-[13px] text-ink-3 [grid-area:time]">
								{row.time}
							</div>
							<div className="flex min-w-0 flex-col gap-px [grid-area:visit]">
								<div className="font-semibold">
									{row.visit}
								</div>
								<div className="text-[13px] text-ink-4">
									{row.client}
								</div>
							</div>
							<div
								className={`[grid-area:tech] ${unassigned ? "font-medium text-ink-5" : "font-semibold"}`}
							>
								{row.tech}
							</div>
							<div className="[grid-area:status]">
								<div
									className={`inline-block whitespace-nowrap rounded-full px-[9px] py-1 text-xs font-bold ${pill.className}`}
								>
									{pill.label}
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function AssistantPanel({
	approval,
	setApproval,
}: {
	approval: Approval;
	setApproval: (a: Approval) => void;
}) {
	return (
		<div
			id="assistant"
			className="flex min-w-0 flex-[1_1_320px] scroll-mt-24 flex-col gap-3.5 border-l border-line bg-rail p-5"
		>
			<div className="flex items-center justify-between">
				<div className="text-base font-bold">Assistant</div>
				<div className="font-mono text-[11px] text-ink-4">
					Alex Mercer · dispatcher
				</div>
			</div>
			<div className="max-w-[88%] self-end rounded-[14px_14px_4px_14px] bg-ink px-3.5 py-[11px] text-[15px] leading-[1.45] text-paper">
				Williams PM at 11 has nobody on it. Who's free?
			</div>
			<div className="max-w-[94%] text-[15px] leading-normal text-sky-ink">
				John Smith is free from 10:45, after the Riverside inspection. Maria
				Rodriguez is on the Anderson PM until noon. I can put John on it.
			</div>
			<div className="flex flex-col gap-2.5 rounded-xl border border-sky-line bg-sky p-3.5">
				<div className="flex items-center justify-between gap-2">
					<div className="font-mono text-[11px] uppercase tracking-[0.12em] text-sky-2">
						assign_technician
					</div>
					<div
						className="text-xs font-bold text-sky-3"
						aria-live="polite"
					>
						{approval === "pending"
							? "Needs approval"
							: approval === "approved"
								? "Approved"
								: "Declined"}
					</div>
				</div>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-sky-ink">
					<div className="text-sky-4">Visit</div>
					<div className="font-semibold">
						Monthly PM — Williams Property Management
					</div>
					<div className="text-sky-4">Technicians</div>
					<div className="font-semibold">John Smith</div>
				</div>
				{approval === "pending" ? (
					<div className="flex gap-2 text-center text-[15px] font-semibold">
						<button
							type="button"
							onClick={() => setApproval("approved")}
							className="flex-1 cursor-pointer rounded-lg bg-sky-btn py-[13px] text-white hover:bg-sky-btn-hover"
						>
							Approve
						</button>
						<button
							type="button"
							onClick={() => setApproval("declined")}
							className="flex-1 cursor-pointer rounded-lg border border-sky-line bg-white py-3 text-sky-3 hover:bg-sky-hover"
						>
							Decline
						</button>
					</div>
				) : (
					<div className="border-t border-sky-line pt-2.5 text-sm leading-[1.45] text-sky-ink">
						{approval === "approved"
							? "Done. John Smith is on the visit. Logged as Assistant · Alex Mercer."
							: "Declined. Nothing was changed."}
					</div>
				)}
			</div>
			{approval !== "pending" && (
				<button
					type="button"
					onClick={() => setApproval("pending")}
					className="cursor-pointer self-start font-mono text-xs text-ink-4 hover:text-ink"
				>
					<span aria-hidden="true">↺ </span>Ask again
				</button>
			)}
			<div className="flex-1" />
			<div className="rounded-[10px] border border-line bg-white px-3.5 py-3 text-sm text-ink-5">
				Ask about jobs, visits, clients…
			</div>
		</div>
	);
}

/** The dispatcher's schedule board and assistant, fed by the hero phone's visit. */
export default function DispatchPreview({ visitStatus }: { visitStatus: VisitStatus }) {
	const [approval, setApproval] = useState<Approval>("pending");
	const assigned = approval === "approved";

	const rows: BoardRow[] = [
		{
			time: "8:00 AM",
			visit: "Annual PM",
			client: "Anderson Office Complex",
			tech: "Maria Rodriguez",
			status: "InProgress",
		},
		{
			time: "9:30 AM",
			visit: "Emergency Boiler Inspection",
			client: "Riverside Apartments LLC",
			tech: "John Smith",
			status: "OnSite",
		},
		{
			time: "11:00 AM",
			visit: "Monthly PM",
			client: "Williams Property Management",
			tech: assigned ? "John Smith" : "Unassigned",
			status: assigned ? "Scheduled" : "Unassigned",
		},
		{
			time: "3:00 PM",
			visit: "AC Repair",
			client: "Johnson Residence",
			tech: "Kevin Park",
			status: visitStatus,
			highlight: true,
		},
		{
			time: "3:30 PM",
			visit: "Rooftop Unit Replacement",
			client: "Smith Commercial Bldg 2",
			tech: "Maria Rodriguez",
			status: "Delayed",
		},
	];

	return (
		<div className="overflow-hidden rounded-[14px] border border-line bg-white shadow-[0_24px_50px_-30px_rgba(23,27,29,0.25)]">
			<div
				aria-hidden="true"
				className="flex items-center gap-2 border-b border-line bg-paper px-4 py-3"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} className="size-[11px] rounded-full bg-dot" />
				))}
				<div className="ml-3 font-mono text-xs text-ink-4">
					tradewerks / dispatch / schedule
				</div>
			</div>
			<div className="flex flex-wrap">
				<div
					aria-hidden="true"
					className="hidden flex-[0_0_176px] flex-col gap-0.5 border-r border-line bg-rail px-3 py-[18px] text-sm font-medium text-ink-2 md:flex"
				>
					{NAV.map((item) =>
						item === "Schedule" ? (
							<div
								key={item}
								className="rounded-md bg-brand-tint px-2.5 py-2 font-bold text-brand-deep"
							>
								{item}
							</div>
						) : (
							<div key={item} className="px-2.5 py-2">
								{item}
							</div>
						)
					)}
				</div>

				<div className="flex min-w-0 flex-[1_1_480px] flex-col gap-4 p-[22px]">
					<div className="flex flex-wrap items-baseline justify-between gap-3">
						<div className="text-[22px] font-bold tracking-[-0.015em]">
							Today
						</div>
						<div className="font-mono text-xs text-ink-4">
							Thu · La Crosse, WI
						</div>
					</div>
					<Board rows={rows} />
				</div>

				<AssistantPanel approval={approval} setApproval={setApproval} />
			</div>
		</div>
	);
}
