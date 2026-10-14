import type { KeyboardEvent, MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarPlus, Clock, Mail, Phone, ShieldCheck, Truck } from "lucide-react";
import type { Technician } from "../../types/technicians";
import { TechnicianStatusLabels } from "../../types/technicians";
import { VisitStatusColors, VisitStatusLabels } from "../../types/jobs";
import { usePermission } from "../../hooks/usePermission";
import TechnicianActionsMenu from "./TechnicianActionsMenu";
import { getTechnicianActivity, type TechnicianActivity } from "./technicianActivity";
import { TECH_COL_VISIBILITY, TECH_ROW_COLS } from "./technicianRosterLayout";
import { capitalizeWords, formatLastLogin, formatTime, visitLabel } from "./technicianFormat";
import { Avatar, MfaMark, NowText, StatusPill, TodayProgress } from "./TechnicianBits";

interface TechnicianCardProps {
	technician: Technician;
	onClick?: () => void;
	onEdit?: (technician: Technician) => void;
	// Admin Users section assigns roles through its own modal; the roster edits role in EditTechnician.
	onAssignRole?: (technician: Technician) => void;
	viewMode?: "card" | "list";
	// "roster" rows sit flush inside the roster's bordered container; "standalone"
	// rows carry their own border for lists that mix in other card types.
	rowStyle?: "roster" | "standalone";
}

function stop(e: MouseEvent) {
	e.stopPropagation();
}

// Card view has room to wrap the title, so the one-word status moves into a corner chip.
// The chip floats so lines past the first reclaim the full box width.
function NowBox({ activity }: { activity: TechnicianActivity }) {
	const vt = activity.current ?? activity.next;
	if (!vt) {
		return (
			<div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
				<p className="text-sm text-text-muted">No upcoming visits today</p>
			</div>
		);
	}

	const isCurrent = vt === activity.current;
	const jobName = vt.visit.job?.name;
	const clientName = vt.visit.job?.client?.name;
	const chip = isCurrent
		? { text: VisitStatusLabels[vt.visit.status], tone: VisitStatusColors[vt.visit.status] }
		: {
				text: `Next ${formatTime(vt.visit.scheduled_start_at)}`,
				tone: "bg-surface-raised/40 text-text-tertiary border-border-strong/40",
			};

	return (
		<div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
			<p
				title={visitLabel(vt)}
				className={`line-clamp-3 break-words text-sm leading-5 ${
					isCurrent ? "text-text-primary" : "text-text-secondary"
				}`}
			>
				<span
					className={`float-right ml-2 mt-px whitespace-nowrap rounded border px-1.5 text-[11px] font-medium leading-4 ${chip.tone}`}
				>
					{chip.text}
				</span>
				{jobName || clientName || "Visit"}
				{jobName && clientName && (
					<span className="text-text-tertiary"> · {clientName}</span>
				)}
			</p>
		</div>
	);
}

function ContactLinks({ technician, displayName }: { technician: Technician; displayName: string }) {
	const link =
		"flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
	return (
		<>
			{technician.phone && (
				<a
					href={`tel:${technician.phone}`}
					onClick={stop}
					aria-label={`Call ${displayName}`}
					title={technician.phone}
					className={link}
				>
					<Phone size={15} />
				</a>
			)}
			{technician.email && (
				<a
					href={`mailto:${technician.email}`}
					onClick={stop}
					aria-label={`Email ${displayName}`}
					title={technician.email}
					className={link}
				>
					<Mail size={15} />
				</a>
			)}
		</>
	);
}

export default function TechnicianCard({
	technician,
	onClick,
	onEdit,
	onAssignRole,
	viewMode = "card",
	rowStyle = "standalone",
}: TechnicianCardProps) {
	const navigate = useNavigate();
	const MANAGE_TECHNICIANS = usePermission("manage_technicians");
	const VIEW_TECHNICIANS = usePermission("view_technicians");

	const displayName = capitalizeWords(technician.name);
	const lastLoginText = formatLastLogin(technician.last_login);
	const activity = getTechnicianActivity(technician);
	const { todayCount, todayDone } = activity;
	const vehicleName = technician.current_vehicle?.name ?? null;
	const subtitle = [technician.title, technician.organization_role?.name].filter(Boolean).join(" · ");
	const openable = VIEW_TECHNICIANS && !!onClick;
	const inactive = !!technician.deactivated_at;
	const inactiveBadge = inactive && (
		<span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-text-tertiary">
			Inactive
		</span>
	);

	// Only the row/card itself — Enter on a nested link or button already acts on its own.
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (!openable || e.target !== e.currentTarget) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onClick?.();
		}
	};

	const interactive = openable
		? {
				// "button", not "link": activation is a JS navigate with no href to open in a new tab.
				role: "button" as const,
				tabIndex: 0,
				"aria-label": `Open ${displayName}`,
				onClick,
				onKeyDown: handleKeyDown,
			}
		: {};

	const assignButton = MANAGE_TECHNICIANS && !inactive && (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				navigate(`/dispatch/technicians/${technician.id}/assign`);
			}}
			aria-label={`Assign visits to ${displayName}`}
			className={`${viewMode === "list" ? "hidden sm:flex" : "flex"} h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
		>
			<CalendarPlus size={14} aria-hidden />
			Assign Visits
		</button>
	);

	const actions = (
		<>
			{assignButton}
			<TechnicianActionsMenu
				technician={technician}
				displayName={displayName}
				onEdit={onEdit}
				onAssignRole={onAssignRole}
				assignInMenuBelowSm={viewMode === "list"}
			/>
		</>
	);

	if (viewMode === "list") {
		return (
			<div
				{...interactive}
				className={`${TECH_ROW_COLS} px-4 ${
					rowStyle === "roster"
						? "border-b border-border-subtle last:border-b-0"
						: "rounded-lg border border-border bg-base"
				} py-2.5 ${
					openable
						? "cursor-pointer transition-colors duration-100 hover:bg-surface focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
						: ""
				}`}
			>
				<div className="flex min-w-0 items-center gap-3">
					<Avatar technician={technician} size="md" />
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-text-primary">{displayName}</p>
						{/* Below sm the status column is hidden, so status rides on this line. */}
						<p className={`truncate text-xs text-text-tertiary ${subtitle ? "" : "sm:hidden"}`}>
							<span className="sm:hidden">
								{inactive ? "Inactive" : TechnicianStatusLabels[technician.status]}
								{subtitle && " · "}
							</span>
							{subtitle}
						</p>
					</div>
				</div>

				<div className={`items-center gap-1.5 ${TECH_COL_VISIBILITY.status}`}>
					<StatusPill technician={technician} />
					<MfaMark enabled={technician.mfaEnabled} />
					{inactiveBadge}
				</div>

				<div
					className={`min-w-0 truncate text-sm ${TECH_COL_VISIBILITY.vehicle} ${
						vehicleName ? "text-text-secondary" : "text-text-muted"
					}`}
					title={vehicleName ?? undefined}
				>
					{vehicleName ?? "—"}
				</div>

				<div className={`min-w-0 ${TECH_COL_VISIBILITY.now}`}>
					<NowText activity={activity} />
				</div>

				<div className={TECH_COL_VISIBILITY.today}>
					<TodayProgress done={todayDone} total={todayCount} />
				</div>

				<div className={`items-center gap-0.5 ${TECH_COL_VISIBILITY.contact}`}>
					<ContactLinks technician={technician} displayName={displayName} />
				</div>

				<div className={`truncate text-xs text-text-tertiary ${TECH_COL_VISIBILITY.lastLogin}`}>
					{lastLoginText}
				</div>

				<div className="flex items-center justify-end gap-1.5">{actions}</div>
			</div>
		);
	}

	return (
		<div
			{...interactive}
			className={`flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-base p-4 ${
				openable
					? "cursor-pointer transition-colors duration-100 hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					: ""
			}`}
		>
			<div className="flex items-start gap-3">
				<Avatar technician={technician} size="lg" />
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-semibold text-text-primary">{displayName}</p>
					{subtitle && <p className="truncate text-xs text-text-tertiary">{subtitle}</p>}
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<StatusPill technician={technician} />
					{inactiveBadge}
				</div>
			</div>

			<NowBox activity={activity} />

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-tertiary">
				<span className="tabular-nums">
					<span className={todayCount > 0 ? "text-text-primary" : undefined}>
						{todayCount}
					</span>{" "}
					{todayCount === 1 ? "visit" : "visits"} today
				</span>
				<span className="flex min-w-0 items-center gap-1">
					<Truck size={13} aria-hidden className="shrink-0" />
					<span className="truncate">{vehicleName ?? "No vehicle"}</span>
				</span>
				{technician.mfaEnabled && (
					<span className="flex items-center gap-1 text-success-text">
						<ShieldCheck size={13} aria-hidden /> MFA
					</span>
				)}
			</div>

			{(technician.phone || technician.email) && (
				<div className="flex min-w-0 flex-col gap-1 text-xs">
					{technician.phone && (
						<a
							href={`tel:${technician.phone}`}
							onClick={stop}
							className="flex w-fit max-w-full items-center gap-2 text-text-secondary hover:text-text-primary"
						>
							<Phone size={13} aria-hidden className="shrink-0 text-text-tertiary" />
							<span className="truncate">{technician.phone}</span>
						</a>
					)}
					{technician.email && (
						<a
							href={`mailto:${technician.email}`}
							onClick={stop}
							className="flex w-fit max-w-full items-center gap-2 text-text-secondary hover:text-text-primary"
						>
							<Mail size={13} aria-hidden className="shrink-0 text-text-tertiary" />
							<span className="truncate">{technician.email}</span>
						</a>
					)}
				</div>
			)}

			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
				<span
					title="Last login"
					className="flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary"
				>
					<Clock size={12} aria-hidden className="shrink-0" />
					<span className="sr-only">Last login:</span>
					<span className="truncate">{lastLoginText}</span>
				</span>
				<div className="flex shrink-0 items-center gap-1.5">{actions}</div>
			</div>
		</div>
	);
}
