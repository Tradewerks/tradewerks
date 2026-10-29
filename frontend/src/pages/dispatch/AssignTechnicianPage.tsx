import { useState, useMemo, useRef } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Mail, Phone, Award, PanelRight, TriangleAlert } from "lucide-react";
import { useTechnicianByIdQuery } from "../../hooks/useTechnicians";
import {
	useAllJobsQuery,
	useAssignTechniciansToVisitMutation,
	useCreateJobVisitMutation,
} from "../../hooks/useJobs";
import CreateJobVisit from "../../components/jobs/CreateJobVisit";
import { VisitStatusColors, VisitStatusLabels, type Job, type JobVisit } from "../../types/jobs";
import { TechnicianStatusDotColors, TechnicianStatusLabels } from "../../types/technicians";
import LoadSvg from "../../assets/icons/loading.svg?react";
import BoxSvg from "../../assets/icons/box.svg?react";
import { useAnyPermission, usePermission } from "../../hooks/usePermission";
import { formatDate, formatTime, formatConstraintTime, errorMessage, FALLBACK_TIMEZONE } from "../../util/util";
import { useToast } from "../../components/ui/useToast";
import {
	getPriorityColor,
	resolveOverlapLayout,
	LEFT_PAD,
	RIGHT_PAD,
} from "../../components/ui/schedule/scheduleBoardUtils";
import { format } from "date-fns";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { useAuthStore } from "../../auth/authStore";
import { isActiveVisit } from "../../lib/jobMapVisits";

const HOUR_PX = 48;
const SHOW_DAY_KEY = "assignTech.showDay";

// Day keys ("YYYY-MM-DD") and hours are in the org's time zone, matching formatDate/formatTime.
const dayKey = (d: Date | string, tz: string) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });

const shiftDayKey = (key: string, days: number) =>
	new Date(Date.parse(key) + days * 864e5).toISOString().slice(0, 10);

const hourIn = (d: Date | string, tz: string) => {
	const [h, m] = new Date(d)
		.toLocaleTimeString("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
		.split(":")
		.map(Number);
	return h + m / 60;
};

// Today and upcoming days first, then past days newest first; times within a day ascending.
const compareVisitDays = (
	a: { day: string; at: Date | string },
	b: { day: string; at: Date | string },
	todayKey: string
) => {
	if (a.day === b.day) return new Date(a.at).getTime() - new Date(b.at).getTime();
	const pastA = a.day < todayKey;
	if (pastA !== b.day < todayKey) return pastA ? 1 : -1;
	return pastA ? b.day.localeCompare(a.day) : a.day.localeCompare(b.day);
};

const constraintLines = (v: JobVisit) => {
	const t = formatConstraintTime;
	return [
		v.arrival_constraint === "at" && v.arrival_time && `Arrive at ${t(v.arrival_time)}`,
		v.arrival_constraint === "between" && v.arrival_window_start && v.arrival_window_end &&
			`Arrive ${t(v.arrival_window_start)} – ${t(v.arrival_window_end)}`,
		v.arrival_constraint === "by" && v.arrival_window_end && `Arrive by ${t(v.arrival_window_end)}`,
		(v.finish_constraint === "at" || v.finish_constraint === "by") && v.finish_time &&
			`Finish ${v.finish_constraint} ${t(v.finish_time)}`,
	].filter((line): line is string => !!line);
};

const dayLabel = (d: Date | string, tz: string, todayKey: string) => {
	const key = dayKey(d, tz);
	if (key === todayKey) return "Today";
	if (key === shiftDayKey(todayKey, 1)) return "Tomorrow";
	return new Date(d).toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
};
import SearchBar from "../../components/ui/SearchBar";

const formatPhone = (value: string | null) => {
	if (!value) return "N/A";
	return value.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");
};

export default function AssignTechnicianPage() {
    const { technicianId } = useParams<{ technicianId: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const [search, setSearch] = useState("");
	const [range, setRange] = useState<"upcoming" | "past">("upcoming");
	const [chip, setChip] = useState<"all" | "unassigned" | "mine" | "conflicts">("all");
	const [showDay, setShowDay] = useState(() => {
		try {
			return localStorage.getItem(SHOW_DAY_KEY) === "1";
		} catch {
			return false;
		}
	});
	const toggleShowDay = () => {
		setShowDay(!showDay);
		try {
			localStorage.setItem(SHOW_DAY_KEY, showDay ? "0" : "1");
		} catch {
			// storage blocked; the toggle still works for this visit
		}
	};
	const tz = useAuthStore((s) => s.user?.orgTimezone) ?? FALLBACK_TIMEZONE;
	const todayKey = dayKey(new Date(), tz);
	const [timelineDay, setTimelineDay] = useState<string | null>(null);
	const dayPickerRef = useRef<HTMLInputElement>(null);
	const shownDay = timelineDay ?? todayKey;
	const [confirmVisit, setConfirmVisit] = useState<JobVisit | null>(null);

	const { data: technician, isLoading: loadingTech } = useTechnicianByIdQuery(technicianId!);
	const { data: jobs, isLoading: loadingJobs, refetch: refetchJobs } = useAllJobsQuery();
	const assignTechnicians = useAssignTechniciansToVisitMutation();
	const { mutateAsync: createJobVisitMutation } = useCreateJobVisitMutation();

	const [isCreatingVisit, setIsCreatingVisit] = useState(false);
	const [creatingVisitForJob, setCreatingVisitForJob] = useState<Job | null>(null);

	//permissions 
	const EDIT_JOBS = usePermission("edit_jobs");
	const CREATE_VISIT = useAnyPermission(["create_jobs", "edit_jobs"]);

	const isVisitAssigned = (visit: JobVisit) => {
		return visit.visit_techs?.some((vt) => vt.tech_id === technicianId);
	};

	const visitName = (v: JobVisit) => v.name || jobs?.find((j) => j.id === v.job_id)?.name || "Unnamed visit";

    const toggleVisitSelection = async (visit: JobVisit) => {
		if (!EDIT_JOBS) return;
		const isAlreadyAssigned = visit.visit_techs?.some(
			(vt) => vt.tech_id === technicianId
		);

		try {
			if (isAlreadyAssigned) {
				const otherTechs =
					visit.visit_techs
						?.filter((vt) => vt.tech_id !== technicianId)
						.map((vt) => vt.tech_id) || [];

				await assignTechnicians.mutateAsync({
					visitId: visit.id,
					techIds: otherTechs,
				});
				toast.success(`${technician?.name ?? "Technician"} has been unassigned from ${visitName(visit)}`);
			} else {
				const currentTechs =
					visit.visit_techs?.map((vt) => vt.tech_id) || [];
				const newTechs = [...currentTechs, technicianId!];

				await assignTechnicians.mutateAsync({
					visitId: visit.id,
					techIds: newTechs,
				});
				toast.success(`${technician?.name ?? "Technician"} has been assigned to ${visitName(visit)}`)
			}

			await refetchJobs();
		} catch (error) {
			toast.error(errorMessage(error, "Failed to update assignment"));
		}
	};

    const handleCreateVisit = (job: Job) => {
		if (!CREATE_VISIT) return;
		setCreatingVisitForJob(job);
		setIsCreatingVisit(true);
	};

	const allVisits = useMemo(() =>
		(jobs ?? [])
			.flatMap((j) => (j.visits ?? []).map((v) => ({ v, j, day: dayKey(v.scheduled_start_at, tz) })))
			.sort((a, b) =>
				compareVisitDays(
					{ day: a.day, at: a.v.scheduled_start_at },
					{ day: b.day, at: b.v.scheduled_start_at },
					todayKey
				)
			),
	[jobs, tz, todayKey]);

	// Visit id → this tech's other visits it overlaps. Keys on the tech's own visits are double-bookings.
	const conflicts = useMemo(() => {
		const time = (d: Date | string) => new Date(d).getTime();
		const isMine = (v: JobVisit) => v.visit_techs?.some((t) => t.tech_id === technicianId);
		const all = allVisits.map(({ v }) => v).filter((v) => v.status !== "Cancelled");
		const mine = all.filter(isMine);
		const map = new Map<string, JobVisit[]>();
		// ponytail: O(visits × tech's visits) overlap scan, fine for one org's job list
		for (const v of all) {
			const hits = mine.filter((m) =>
				m.id !== v.id &&
				time(m.scheduled_start_at) < time(v.scheduled_end_at) &&
				time(v.scheduled_start_at) < time(m.scheduled_end_at)
			);
			if (hits.length) map.set(v.id, hits);
		}
		return map;
	}, [allVisits, technicianId]);

	const q = search.trim().toLowerCase();

	const sortedVisits = useMemo(() => {
		const isMine = (v: JobVisit) => v.visit_techs?.some((t) => t.tech_id === technicianId);

		return allVisits.filter(({ v, j, day }) =>
			v.status !== "Cancelled" &&
			(range === "upcoming"
				? day >= todayKey && v.status !== "Completed"
				: day < todayKey || v.status === "Completed") &&
			(chip === "all" ||
				(chip === "unassigned" && !v.visit_techs?.length) ||
				(chip === "mine" && isMine(v)) ||
				(chip === "conflicts" && isMine(v) && conflicts.has(v.id))) &&
			(!q || [v.name, j.name, j.client?.name, j.address].some((s) => s?.toLowerCase().includes(q)))
		);
	}, [allVisits, conflicts, q, range, chip, technicianId, todayKey]);

	const visitsByDay = useMemo(() => {
		const groups = new Map<string, typeof sortedVisits>();
		for (const i of sortedVisits) {
			groups.set(i.day, [...(groups.get(i.day) ?? []), i]);
		}
		return groups;
	}, [sortedVisits]);

	const resolvedJobStatus = ["Completed", "Cancelled"];

	if (loadingTech || loadingJobs) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<LoadSvg className="w-12 h-12" />
			</div>
		);
	}

    if (!technician) {
		return (
			<div className="p-6">
				<div className="text-text-primary">Technician not found</div>
			</div>
		);
	}

	// Any visit that overlaps the day, clipped to midnight on either side
	const blocksOn = (key: string) => allVisits
		.filter(({ v, day }) => v.status !== "Cancelled" && isVisitAssigned(v) && day <= key)
		.flatMap(({ v, j, day }) => {
			const endDay = dayKey(v.scheduled_end_at, tz);
			if (endDay < key) return [];
			const start = day < key ? 0 : hourIn(v.scheduled_start_at, tz);
			const end = endDay > key ? 24 : hourIn(v.scheduled_end_at, tz);
			// Ended exactly at midnight that morning
			if (end === 0 && start === 0) return [];
			return [{ v, j, start, end: Math.min(24, Math.max(end, start + 0.5)) }];
		});
	const todayBlocks = blocksOn(todayKey);
	const dayBlocks = shownDay === todayKey ? todayBlocks : blocksOn(shownDay);
	const dayFrom = Math.min(7, ...dayBlocks.map((b) => Math.floor(b.start)));
	const dayTo = Math.min(24, Math.max(18, ...dayBlocks.map((b) => Math.ceil(b.end))));
	const minutesToday = Math.round(todayBlocks.reduce((sum, b) => sum + b.end - b.start, 0) * 60);
	// Percent-based lanes: usable width of 100 after the util's px pads
	const blockLanes = new Map(
		resolveOverlapLayout(
			dayBlocks.map((b) => ({ id: b.v.id, span: { startH: b.start, endH: b.end, openEnded: false } })),
			100 + LEFT_PAD + RIGHT_PAD
		).map((s) => [s.visit.id, { left: s.left - LEFT_PAD, width: s.width }])
	);

	// Same set as the "Upcoming" range, so the tile counts match the filtered list
	const upcoming = allVisits.filter(({ v, day }) =>
		v.status !== "Cancelled" &&
		v.status !== "Completed" &&
		day >= todayKey
	);
	const upcomingMine = upcoming.filter(({ v }) => isVisitAssigned(v)).length;
	const upcomingUnassigned = upcoming.filter(({ v }) => !v.visit_techs?.length).length;
	const upcomingConflicts = upcoming.filter(({ v }) => isVisitAssigned(v) && conflicts.has(v.id)).length;
	const confirmOverlaps = (confirmVisit && conflicts.get(confirmVisit.id)) || [];
	const jobsWithoutVisits = (jobs ?? []).filter(
		(j) =>
			!j.visits?.length &&
			j.status !== "Completed" &&
			j.status !== "Cancelled" &&
			(!q || [j.name, j.client?.name, j.address].some((s) => s?.toLowerCase().includes(q)))
	);
	const showChip = (c: typeof chip) => {
		setRange("upcoming");
		setChip(c);
	};

    return (
        <div className="min-h-screen bg-canvas">
			{/* Header Section */}
			<div className="border-b border-border-subtle">
				<div className="w-full px-6 pb-6">
					{/* Page Title */}
					<div className="mb-3">
						<h2 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
							Assign Technician
						</h2>
					</div>

					<div className="flex flex-wrap items-center gap-x-8 gap-y-4">
						{/* Avatar + Status */}
						<div className="relative flex-shrink-0">
							<div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 p-0.5">
								<div className="w-full h-full rounded-2xl bg-base flex items-center justify-center">
									<span className="text-text-primary text-2xl font-bold">
										{technician.name
											.charAt(0)
											.toUpperCase()}
									</span>
								</div>
							</div>

							<div className="absolute -bottom-2 -right-2 flex items-center gap-1.5 bg-base border border-border-subtle rounded-full px-2.5 py-1">
								<div
									className={`w-2 h-2 rounded-full ${TechnicianStatusDotColors[technician.status]}`}
								/>
								<span className="text-xs font-medium text-text-primary">
									{TechnicianStatusLabels[technician.status]}
								</span>
							</div>
						</div>

						{/* Name + Title */}
						<div className="min-w-[220px]">
							<h1 className="text-2xl font-bold text-text-primary leading-tight">
								<Link
									to={`/dispatch/technicians/${technicianId}`}
									className="rounded-md hover:text-primary-text transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
								>
									{technician.name}
								</Link>
							</h1>
							<div className="flex items-center gap-1.5 mt-1">
								<Award
									size={14}
									className="text-primary-text"
								/>
								<span className="text-sm text-text-tertiary">
									{technician.title}
								</span>
							</div>
						</div>

						{/* Contact Info */}
						<div className="flex flex-col gap-2 min-w-[260px]">
							<div className="flex items-center gap-2 text-sm bg-surface-raised rounded-lg px-3 py-2">
								<Mail
									size={14}
									className="text-text-muted"
								/>
								<span className="text-text-secondary truncate">
									{technician.email}
								</span>
							</div>
							<div className="flex items-center gap-2 text-sm bg-surface-raised rounded-lg px-3 py-2">
								<Phone
									size={14}
									className="text-text-muted"
								/>
								<span className="text-text-secondary">
									{formatPhone(technician.phone)}
								</span>
							</div>
						</div>

						{/* Spacer */}
						<div className="flex-1" />

						{/* Stats */}
						<div className="flex flex-wrap gap-3">
							<div className="bg-surface/50 border border-border rounded-lg px-4 py-3 text-center min-w-[90px]">
								<div className="text-2xl font-bold text-text-primary">
									{todayBlocks.length}
								</div>
								<div className="text-xs text-text-tertiary mt-0.5">
									Today
								</div>
							</div>

							<div className="bg-surface/50 border border-border rounded-lg px-4 py-3 text-center min-w-[90px]">
								<div className="text-2xl font-bold text-text-primary whitespace-nowrap">
									{Math.floor(minutesToday / 60)}h
									{minutesToday % 60 > 0 && ` ${minutesToday % 60}m`}
								</div>
								<div className="text-xs text-text-tertiary mt-0.5">
									Booked
								</div>
							</div>

							<button
								type="button"
								onClick={() => showChip("mine")}
								className="bg-surface/50 border border-border rounded-lg px-4 py-3 text-center min-w-[90px] hover:bg-surface-raised transition-colors"
							>
								<div className="text-2xl font-bold text-text-primary">
									{upcomingMine}
								</div>
								<div className="text-xs text-text-tertiary mt-0.5">
									Upcoming
								</div>
							</button>

							<button
								type="button"
								onClick={() => showChip("unassigned")}
								className="bg-surface/50 border border-border rounded-lg px-4 py-3 text-center min-w-[90px] hover:bg-surface-raised transition-colors"
							>
								<div className="text-2xl font-bold text-text-primary">
									{upcomingUnassigned}
								</div>
								<div className="text-xs text-text-tertiary mt-0.5">
									Unassigned
								</div>
							</button>

							<button
								type="button"
								onClick={() => showChip("conflicts")}
								className={`rounded-lg px-4 py-3 text-center min-w-[90px] border transition-colors ${
									upcomingConflicts
										? "bg-warning/10 border-warning/40 hover:bg-warning/20"
										: "bg-surface/50 border-border hover:bg-surface-raised"
								}`}
							>
								<div className={`text-2xl font-bold ${upcomingConflicts ? "text-warning-text" : "text-text-primary"}`}>
									{upcomingConflicts}
								</div>
								<div className="text-xs text-text-tertiary mt-0.5">
									Conflicts
								</div>
							</button>
						</div>
					</div>
				</div>
			</div>

            {/** Job visit and user schedule */}
            <div className="flex flex-col lg:flex-row">
                {/** Job visits */}
                <div className="@container flex-1 min-w-0">
                    {jobs?.length ? (
                        <div className="flex flex-col gap-2 p-6">
							<div className="flex flex-wrap gap-3">
								<SearchBar className="min-w-60 flex-1" placeholder="Search visits, clients, and addresses" value={search} onChange={setSearch} />
								<div className="inline-flex shrink-0 rounded-md border border-border p-0.5">
									{(["upcoming", "past"] as const).map((r) => (
										<button
											key={r}
											type="button"
											aria-pressed={range === r}
											onClick={() => setRange(r)}
											className={`rounded px-3 text-sm font-medium capitalize transition-colors ${
												range === r ? "bg-surface-raised text-text-primary" : "text-text-tertiary hover:text-text-primary"
											}`}
										>
											{r}
										</button>
									))}
								</div>
								<button
									type="button"
									aria-pressed={showDay}
									onClick={toggleShowDay}
									className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors ${
										showDay
											? "border-primary bg-primary/10 text-primary-text"
											: "border-border text-text-tertiary hover:text-text-primary"
									}`}
								>
									<PanelRight size={16} />
									Day timeline
								</button>
							</div>
							<div className="flex flex-wrap gap-2">
								{([
									["all", "All"],
									["unassigned", "None assigned"],
									["mine", `${technician.name.split(" ")[0]}'s`],
									["conflicts", "Conflicts"],
								] as const).map(([id, label]) => (
									<button
										key={id}
										type="button"
										aria-pressed={chip === id}
										onClick={() => setChip(id)}
										className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
											chip === id
												? "border-primary bg-primary text-white"
												: "border-border-subtle bg-surface text-text-secondary hover:bg-surface-raised"
										}`}
									>
										{label}
									</button>
								))}
							</div>
							{range === "upcoming" && jobsWithoutVisits.length > 0 && (
								<details open className="group/jobs rounded-lg border border-border-subtle bg-surface overflow-auto">
									<summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-semibold text-text-primary">
										<ChevronDown size={16} className="text-text-muted transition-transform -rotate-90 group-open/jobs:rotate-0" />
										Jobs with no visits yet
										<span className="rounded-full bg-surface-raised px-2 text-xs font-medium text-text-secondary">
											{jobsWithoutVisits.length}
										</span>
									</summary>
									{jobsWithoutVisits.map((j) => (
										<div key={j.id} className="flex items-center gap-2 border-t border-border-subtle bg-base px-4 py-3">
											<Link
												to={`/dispatch/jobs/${j.id}`}
												className="group -m-1 flex min-w-0 flex-1 flex-col gap-0.5 rounded-md p-1 text-sm transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
											>
												<p className="font-semibold text-text-primary group-hover:text-primary-text group-hover:underline">
													{j.name}
												</p>
												<span className="flex items-center gap-1.5 text-xs text-text-secondary">
													<span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: getPriorityColor(j.priority) }} />
													{j.priority}
												</span>
												<p className="text-xs text-text-muted truncate">
													{j.client?.name} · {j.address}
												</p>
											</Link>
											<button
												type="button"
												onClick={() => handleCreateVisit(j)}
												disabled={!CREATE_VISIT}
												title={!CREATE_VISIT ?"You don't have permission to perform this action" : undefined}
												className="inline-flex w-24 shrink-0 items-center justify-center gap-1 rounded-md border border-border-subtle bg-surface pr-4 pl-1 py-1.5 text-sm font-medium text-text-primary transition-colors hover:enabled:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed"
											>
												<Plus size={14} />
												Visit
											</button>
										</div>
									))}
								</details>
							)}
							{sortedVisits.length === 0 && (
								<p className="py-8 text-center text-sm text-text-muted">No visits match these filters.</p>
							)}
							{[...visitsByDay].map(([day, items])=>(
								<div key={day}>
									<h3 className="flex items-baseline gap-2">
										<span className="font-bold">{dayLabel(items[0].v.scheduled_start_at, tz, todayKey)}</span>
										<span className="text-sm text-text-muted">{formatDate(items[0].v.scheduled_start_at, tz)}</span>
									</h3>
									<div className="rounded-lg border border-border-subtle bg-surface overflow-auto">
										{items.map(({ v, j }) => (
											<div 
												key={v.id} 
												className={`flex flex-wrap items-start gap-2 border border-border-subtle bg-base px-4 py-3
													${v.visit_techs.some((t) => t.tech_id === technicianId) ? "border-l-primary border-l-3" : ""}`}
											>
											<div className="flex flex-1 min-w-48 flex-col gap-1 @2xl:flex-row @2xl:gap-2">
												<span className="w-36 shrink-0 text-sm font-medium text-text-primary">
												{formatTime(v.scheduled_start_at, tz)} - {formatTime(v.scheduled_end_at, tz)}
												{constraintLines(v).map((line) => (
													<p key={line} className="text-xs font-normal text-text-muted">{line}</p>
												))}
												<p className="text-xs font-normal text-text-muted">
													{formatDate(v.scheduled_start_at, tz)}
													{formatDate(v.scheduled_end_at, tz) !== formatDate(v.scheduled_start_at, tz) && ` - ${formatDate(v.scheduled_end_at, tz)}`}
												</p>
												
											</span>
											<Link
												to={`/dispatch/jobs/${j.id}/visits/${v.id}`}
												className="group -m-1 flex min-w-48 flex-1 flex-col gap-0.5 rounded-md p-1 text-left text-sm transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
											>
												<p className="font-semibold text-text-primary flex gap-2 group-hover:text-primary-text group-hover:underline">
													{visitName(v)}
												</p>
												<span className="flex gap-2">
													<span className="flex font-normal items-center gap-1.5 text-xs text-text-secondary"><span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: getPriorityColor(j.priority) }}/>{j.priority}</span>
													{v.status !== "Scheduled" && (
														<span className={`rounded-full border px-2 text-xs font-medium ${VisitStatusColors[v.status]} w-fit`}>
															{VisitStatusLabels[v.status]}
														</span>
													)}
												</span>
													
												<p className="text-text-secondary line-clamp-2">{v.description}</p>
												<p className="text-xs text-text-muted truncate">{j.address}</p>
												{conflicts.has(v.id) && (
													<p className="flex gap-1 text-xs font-medium text-warning-text bg-warning/40 w-fit px-1 rounded-md items-center">
														<TriangleAlert size={14} aria-hidden="true" className="shrink-0" /> Overlaps {conflicts.get(v.id)!.map(visitName).join(", ")}
													</p>
												)}
											</Link>
											</div>
											<span className="ml-auto flex w-20 shrink-0 justify-end gap-1 self-center">
												{v.visit_techs
													?.filter((vt) => vt.tech_id !== technicianId)
													.map((vt) => (
														<button
															type="button"
															key={vt.tech_id}
															title={vt.tech.name}
															aria-label={`Open ${vt.tech.name}'s assignments`}
															className={`grid size-6 hover:cursor-pointer place-items-center rounded-full border border-border 
																bg-surface-raised text-[10px] font-semibold text-text-secondary focus-visible:outline-2 
																focus-visible:outline-offset-2 focus-visible:outline-primary
															`}
															onClick={() => navigate(`/dispatch/technicians/${vt.tech_id}/assign`)}
														>
															{vt.tech.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
														</button>
												))}
											</span>
											<span className="shrink-0 self-center">
												<button
													onClick={() => (!isVisitAssigned(v) && conflicts.has(v.id) ? setConfirmVisit(v) : toggleVisitSelection(v))}
													disabled={!EDIT_JOBS || assignTechnicians.isPending || resolvedJobStatus.includes(v.status)}
													className={`w-24 rounded-md disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-medium border transition-colors ${
														v.visit_techs.some((t) => t.tech_id === technicianId)
															? "bg-primary text-white border-primary-border hover:bg-primary-hover disabled:hover:bg-primary"
															: "border-border-subtle text-text-primary bg-surface hover:bg-surface-raised disabled:hover:bg-surface"
													}`}
												>
													{v.visit_techs.some((t) => t.tech_id === technicianId)
														? "Assigned"
														: "Assign"
													}
												</button>
											</span>
										</div>
									))}
									</div>
								</div>
							))}
							
                        </div>
                    ) : (
						<div className="m-6 flex flex-col items-center justify-center py-12 bg-base rounded-lg border border-border-subtle">
							<BoxSvg className="w-16 h-16 mb-3 opacity-50" />
							<p className="text-text-tertiary">No jobs available</p>
							<p className="text-sm text-text-muted mt-1">
								Create a job to start assigning visits
							</p>
						</div>
                    )}
                </div>
				{/** Technician schedule */}
				{showDay && (
				// Stacks above the list on narrow screens so it doesn't squeeze the rows
				<aside aria-label="Day timeline" className="order-first px-6 pt-6 lg:order-none lg:w-96 lg:shrink-0 lg:border-l lg:border-border-subtle lg:p-6 lg:pl-4">
					<div className="rounded-lg border border-border-subtle bg-surface p-4">
						<h3 className="mb-3 font-semibold text-text-primary">{technician.name}'s day</h3>
						<div className="mb-4 flex items-center gap-1">
							<button
								type="button"
								className="px-3 py-1.5 border border-border-subtle rounded-md text-sm bg-surface hover:enabled:bg-surface-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
								onClick={() => setTimelineDay(null)}
								disabled={shownDay === todayKey}
							>
								Today
							</button>
							<button
								type="button"
								className="p-2 border border-border-subtle rounded-md bg-surface hover:bg-surface-raised transition-colors"
								onClick={() => setTimelineDay(shiftDayKey(shownDay, -1))}
								aria-label="Previous day"
							>
								<ChevronLeft size={14} />
							</button>
							<button
								type="button"
								className="flex-1 px-3 py-1.5 border border-border-subtle rounded-md text-sm tabular-nums bg-surface hover:bg-surface-raised transition-colors"
								onClick={() => dayPickerRef.current?.showPicker()}
							>
								{/* Noon UTC keeps the key's calendar date when formatted */}
								{new Date(`${shownDay}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
							</button>
							<input
								ref={dayPickerRef}
								type="date"
								className="sr-only"
								tabIndex={-1}
								aria-hidden
								value={shownDay}
								onChange={(e) => e.target.value && setTimelineDay(e.target.value)}
							/>
							<button
								type="button"
								className="p-2 border border-border-subtle rounded-md bg-surface hover:bg-surface-raised transition-colors"
								onClick={() => setTimelineDay(shiftDayKey(shownDay, 1))}
								aria-label="Next day"
							>
								<ChevronRight size={14} />
							</button>
						</div>
						<div
							className="relative ml-13 cursor-default border-l border-border-subtle"
							style={{ height: (dayTo - dayFrom) * HOUR_PX }}
						>
							{Array.from({ length: dayTo - dayFrom + 1 }, (_, i) => dayFrom + i).map((h) => (
								<div
									key={h}
									className="absolute inset-x-0 border-t border-border-subtle"
									style={{ top: (h - dayFrom) * HOUR_PX }}
								>
									<span className="absolute -left-13 -top-2 w-11 text-right text-xs text-text-muted">
										{format(new Date(0, 0, 0, h), "h a")}
									</span>
								</div>
							))}
							<div className="absolute inset-y-0 left-2 right-1">
							{dayBlocks.map(({ v, j, start, end }) => (
								<div
									key={v.id}
									className={`absolute overflow-hidden rounded-md border-l-3 px-2.5 py-1.5 ${
										conflicts.has(v.id)
											? "border-warning bg-warning/15 text-warning-text"
											: "border-primary bg-primary/15 text-primary-text"
									}`}
									style={{
										top: (start - dayFrom) * HOUR_PX + 1,
										height: (end - start) * HOUR_PX - 3,
										left: `${blockLanes.get(v.id)?.left ?? 0}%`,
										width: `${blockLanes.get(v.id)?.width ?? 100}%`,
									}}
								>
									<p className="truncate text-xs font-semibold" title={visitName(v)}>{visitName(v)}</p>
									<p 
										className="truncate text-xs opacity-85"
										title={formatDate(v.scheduled_start_at, tz) !== formatDate(v.scheduled_end_at, tz)
											? `${formatDate(v.scheduled_start_at, tz)} ${formatTime(v.scheduled_start_at, tz)} - ${formatDate(v.scheduled_end_at, tz)} ${formatTime(v.scheduled_end_at, tz)} · ${j.client?.name}`
											: `${formatTime(v.scheduled_start_at, tz)} - ${formatTime(v.scheduled_end_at, tz)} · ${j.client?.name}`}
									>
										{formatDate(v.scheduled_start_at, tz) !== formatDate(v.scheduled_end_at, tz)
											? `${formatDate(v.scheduled_start_at, tz)} ${formatTime(v.scheduled_start_at, tz)} - ${formatDate(v.scheduled_end_at, tz)} ${formatTime(v.scheduled_end_at, tz)}`
											: `${formatTime(v.scheduled_start_at, tz)} - ${formatTime(v.scheduled_end_at, tz)}`}
										{" · "}{j.client?.name}
									</p>
								</div>
							))}
							</div>
						</div>
					</div>
				</aside>
				)}
            </div>

			{creatingVisitForJob && (
				<CreateJobVisit
					isModalOpen={isCreatingVisit}
					setIsModalOpen={setIsCreatingVisit}
					jobId={creatingVisitForJob.id}
					createVisit={createJobVisitMutation}
					preselectedTechId={technicianId}
					onSuccess={async () => {
						setIsCreatingVisit(false);
						setCreatingVisitForJob(null);
						await refetchJobs();
					}}
				/>
			)}

			<ConfirmDialog
				open={!!confirmVisit}
				title={confirmOverlaps.length ? "Schedule conflict" : "Conflicts cleared"}
				body={confirmOverlaps.length ? (
					 <>
						<p>{technician.name} is already on these at the same time:</p>
						<ul className="mt-2 space-y-1">
							{confirmOverlaps.map((m) => {
								// Backend refuses to empty an active or completed visit
								const locked = (isActiveVisit(m) || m.status === "Completed") && m.visit_techs.length === 1;
								return (
								<li key={m.id} className="flex items-center justify-between gap-2">
									<span>{visitName(m)}</span>
									<button
										type="button"
										onClick={() => toggleVisitSelection(m)}
										disabled={assignTechnicians.isPending || locked}
										title={locked ? `${VisitStatusLabels[m.status]} visits need a technician. Assign someone else first.` : undefined}
										className="inline-flex items-center shrink-0 h-7 px-2.5 rounded-md bg-surface hover:enabled:bg-error/10 border border-border hover:enabled:border-error/40 text-xs font-medium text-text-secondary hover:enabled:text-error-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
									>
										Unassign
									</button>
								</li>
								);
							})}
						</ul>
					</>
				) : (
					<p>
						{technician.name} is free at this time now. Assign them to{" "}
						{confirmVisit && visitName(confirmVisit)}?
					</p>
				)}
				confirmLabel={confirmOverlaps.length ? "Assign anyway" : "Assign"}
				pending={assignTechnicians.isPending}
				onConfirm={async () => {
					await toggleVisitSelection(confirmVisit!);
					setConfirmVisit(null);
				}}
				onCancel={() => setConfirmVisit(null)}
			/>
        </div>
    )
}