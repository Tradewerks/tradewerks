import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, Briefcase, ChevronDown, Clock, Layers, Route, User, Users, Wrench } from "lucide-react";
import type { Technician } from "../../../types/technicians";
import { TechnicianStatusDotColors } from "../../../types/technicians";
import type { TechRouteData } from "../../../types/location";
import type { Client } from "../../../types/clients";
import { useLiveVisitUpdates } from "../../../hooks/useLiveVisitUpdates";
import type { FeedEvent } from "../../../types/technicians";
import { getEventText, getStatusColor, timeAgo } from "./visitFeedUtils";
import LiveDot from "./LiveDot";

export interface MapFilters {
	showClients: boolean;
	hiddenClientIds: Set<string>;
	showRoutes: boolean;
	hiddenRouteIds: Set<string>;
	showETAs: boolean;
	hiddenETAIds: Set<string>;
	showTechs: boolean;
	hiddenTechIds: Set<string>;
}

interface MapPanelProps {
	allClients: Client[];
	allTechnicians: Technician[];
	drivingRoutes: TechRouteData[];
	filters: MapFilters;
	onChange: (next: MapFilters) => void;
}

function formatEta(seconds: number | null): string {
	if (seconds === null) return "…";
	const mins = Math.max(1, Math.round(seconds / 60));
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function hasValidCoords(c: { lat: number; lon: number } | null | undefined): boolean {
	return (
		!!c &&
		Number.isFinite(c.lat) &&
		Number.isFinite(c.lon) &&
		!(c.lat === 0 && c.lon === 0)
	);
}

function toggleInSet(set: Set<string>, id: string): Set<string> {
	const next = new Set(set);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

export default function MapPanel({
	allClients,
	allTechnicians,
	drivingRoutes,
	filters,
	onChange,
}: MapPanelProps) {
	const sortedClients = useMemo(
		() => [...allClients].sort((a, b) => a.name.localeCompare(b.name)),
		[allClients]
	);
	const sortedTechs = useMemo(
		() => [...allTechnicians].sort((a, b) => a.name.localeCompare(b.name)),
		[allTechnicians]
	);
	const sortedRoutes = useMemo(
		() => [...drivingRoutes].sort((a, b) => a.techName.localeCompare(b.techName)),
		[drivingRoutes]
	);

	const { events, unreadCount, clearUnread } = useLiveVisitUpdates();
	const [liveOpen, setLiveOpen] = useState(false);

	useEffect(() => {
		if (!liveOpen || unreadCount === 0) return;
		const id = setTimeout(clearUnread, 5000);
		return () => clearTimeout(id);
	}, [liveOpen, unreadCount, clearUnread]);

	return (
		<div className="flex flex-col bg-base border border-border-subtle rounded-xl w-full h-full overflow-hidden">
			<div className="flex flex-col flex-1 min-h-0">
				{/* Map Controls — scrolls internally if sections are expanded */}
				<div className="flex flex-col shrink-0 max-h-[55%]">
					<div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle bg-base shrink-0">
						<Layers
							size={12}
							className="text-text-secondary shrink-0"
						/>
						<span className="text-[10px] font-bold text-text-primary uppercase tracking-widest">
							Map Controls
						</span>
					</div>
				<div className="overflow-y-auto min-h-0 scrollbar-thin">

					<Section
						icon={<Users size={14} />}
						title="Clients"
						count={sortedClients.length}
						master={filters.showClients}
						onMaster={(v) =>
							onChange({ ...filters, showClients: v })
						}
						defaultOpen={false}
					>
						{sortedClients.length === 0 ? (
							<EmptyHint>No clients.</EmptyHint>
						) : (
							sortedClients.map((c) => {
								const validCoords = hasValidCoords(
									c.coords
								);
								const hidden =
									filters.hiddenClientIds.has(
										c.id
									);
								return (
									<ItemToggle
										key={c.id}
										checked={!hidden}
										disabled={
											!validCoords ||
											!filters.showClients
										}
										onChange={() =>
											onChange({
												...filters,
												hiddenClientIds:
													toggleInSet(
														filters.hiddenClientIds,
														c.id
													),
											})
										}
										label={c.name}
										sublabel={
											validCoords
												? undefined
												: "no location"
										}
										dot={
											<span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
										}
									/>
								);
							})
						)}
					</Section>

					<Section
						icon={<Route size={14} />}
						title="Routes"
						count={sortedRoutes.length}
						master={filters.showRoutes}
						onMaster={(v) =>
							onChange({ ...filters, showRoutes: v })
						}
						defaultOpen={true}
					>
						{sortedRoutes.length === 0 ? (
							<EmptyHint>
								No technicians currently driving.
							</EmptyHint>
						) : (
							sortedRoutes.map((route) => {
								const hidden =
									filters.hiddenRouteIds.has(
										route.techId
									);
								return (
									<ItemToggle
										key={route.techId}
										checked={!hidden}
										disabled={
											!filters.showRoutes
										}
										onChange={() =>
											onChange({
												...filters,
												hiddenRouteIds:
													toggleInSet(
														filters.hiddenRouteIds,
														route.techId
													),
											})
										}
										label={
											route.techName
										}
										sublabel={`→ ${route.destinationLabel}`}
										dot={
											<span
												className="w-3 h-3 rounded-full flex-shrink-0 border border-canvas"
												style={{
													backgroundColor:
														route.color,
												}}
											/>
										}
									/>
								);
							})
						)}
					</Section>

					<Section
						icon={<Clock size={14} />}
						title="ETA Labels"
						count={sortedRoutes.length}
						master={filters.showETAs}
						onMaster={(v) =>
							onChange({ ...filters, showETAs: v })
						}
						defaultOpen={false}
					>
						{sortedRoutes.length === 0 ? (
							<EmptyHint>No active ETAs.</EmptyHint>
						) : (
							sortedRoutes.map((route) => {
								const hidden =
									filters.hiddenETAIds.has(
										route.techId
									);
								return (
									<ItemToggle
										key={route.techId}
										checked={!hidden}
										disabled={
											!filters.showETAs
										}
										onChange={() =>
											onChange({
												...filters,
												hiddenETAIds:
													toggleInSet(
														filters.hiddenETAIds,
														route.techId
													),
											})
										}
										label={
											route.techName
										}
										sublabel={formatEta(
											route.etaSeconds
										)}
										dot={
											<span
												className="w-3 h-3 rounded-full flex-shrink-0 border border-canvas"
												style={{
													backgroundColor:
														route.color,
												}}
											/>
										}
									/>
								);
							})
						)}
					</Section>

					<Section
						icon={<Wrench size={14} />}
						title="Technicians"
						count={sortedTechs.length}
						master={filters.showTechs}
						onMaster={(v) =>
							onChange({ ...filters, showTechs: v })
						}
						defaultOpen={true}
					>
						{sortedTechs.length === 0 ? (
							<EmptyHint>No technicians.</EmptyHint>
						) : (
							sortedTechs.map((tech) => {
								const validCoords = hasValidCoords(
									tech.coords
								);
								const hidden =
									filters.hiddenTechIds.has(
										tech.id
									);
								return (
									<ItemToggle
										key={tech.id}
										checked={!hidden}
										disabled={
											!validCoords ||
											!filters.showTechs
										}
										onChange={() =>
											onChange({
												...filters,
												hiddenTechIds:
													toggleInSet(
														filters.hiddenTechIds,
														tech.id
													),
											})
										}
										label={tech.name}
										sublabel={
											validCoords
												? tech.status
												: "no location"
										}
										dot={
											<LiveDot
												status={tech.status}
												lastPingAt={tech.last_ping_at}
												dotClassName={TechnicianStatusDotColors[tech.status]}
											/>
										}
									/>
								);
							})
						)}
					</Section>
				</div>
				</div>

				{/* Live Updates — fills remaining panel space */}
				<div className="flex flex-col flex-1 min-h-0 border-t border-border-subtle">
					<button
						onClick={() => {
							const opening = !liveOpen;
							setLiveOpen(opening);
							if (opening) clearUnread();
						}}
						className="relative flex w-full items-center gap-2 px-3 py-2.5 bg-surface/40 border-b border-border-subtle hover:bg-surface/60 transition-colors shrink-0"
					>
						<Activity
							size={12}
							className={`shrink-0 transition-colors ${unreadCount > 0 || liveOpen ? "text-primary-text" : "text-text-tertiary"}`}
						/>
						<span className="text-[10px] font-bold text-text-primary uppercase tracking-widest flex-1 text-left">
							Live Updates
						</span>
						{unreadCount > 0 && (
							<span className="absolute right-7 top-1/2 -translate-y-1/2 flex items-center justify-center min-w-[18px] h-[18px] px-1.5 bg-error text-on-primary font-bold rounded-full text-[10px] leading-none">
								{unreadCount > 9 ? "9+" : unreadCount}
							</span>
						)}
						<ChevronDown
							size={12}
							className={`text-text-primary transition-transform duration-150 shrink-0 ${liveOpen ? "" : "-rotate-90"}`}
						/>
					</button>
					{liveOpen && (
						<div className="flex-1 overflow-y-auto min-h-0 px-1 pb-2 scrollbar-thin">
							{events.length === 0 ? (
								<p className="text-xs text-text-faint italic px-2 py-1.5">
									No recent activity.
								</p>
							) : (
								<ul>
									{events.map((event, i) => (
										<VisitFeedItem
											key={`${event.changedAt}-${i}`}
											event={
												event
											}
										/>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

interface SectionProps {
	icon: React.ReactNode;
	title: string;
	count: number;
	master: boolean;
	onMaster: (next: boolean) => void;
	defaultOpen?: boolean;
	children: React.ReactNode;
}

function Section({
	icon,
	title,
	count,
	master,
	onMaster,
	defaultOpen = false,
	children,
}: SectionProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section className="border-b border-border-subtle">
			<div className="flex items-center gap-2 px-3 py-2 hover:bg-surface/40 transition-colors">
				<button
					onClick={() => setOpen((v) => !v)}
					className="flex items-center gap-2 flex-1 text-left"
				>
					<ChevronDown
						size={14}
						className={`text-text-muted transition-transform ${open ? "" : "-rotate-90"}`}
					/>
					<span className="text-text-tertiary flex-shrink-0">{icon}</span>
					<span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
						{title}
					</span>
					<span className="text-[10px] text-text-muted">({count})</span>
				</button>
				<input
					type="checkbox"
					checked={master}
					onChange={(e) => onMaster(e.target.checked)}
					className="accent-blue-500 cursor-pointer"
					title={`Toggle all ${title.toLowerCase()}`}
				/>
			</div>
			{open && <ul className="px-2 pb-2 space-y-0.5">{children}</ul>}
		</section>
	);
}

interface ItemToggleProps {
	checked: boolean;
	disabled?: boolean;
	onChange: () => void;
	label: string;
	sublabel?: string;
	dot?: React.ReactNode;
}

function ItemToggle({ checked, disabled, onChange, label, sublabel, dot }: ItemToggleProps) {
	return (
		<li>
			<label
				className={`flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${
					disabled
						? "opacity-40 cursor-not-allowed"
						: "hover:bg-surface cursor-pointer"
				}`}
			>
				{dot}
				<div className="min-w-0 flex-1">
					<p className="text-xs text-text-primary truncate">{label}</p>
					{sublabel && (
						<p className="text-[10px] text-text-muted truncate">
							{sublabel}
						</p>
					)}
				</div>
				<input
					type="checkbox"
					checked={checked}
					disabled={disabled}
					onChange={onChange}
					className="accent-blue-500"
				/>
			</label>
		</li>
	);
}

function EmptyHint({ children }: { children: React.ReactNode }) {
	return <li className="text-xs text-text-faint italic px-2 py-1.5">{children}</li>;
}

function VisitFeedItem({ event }: { event: FeedEvent }) {
	const navigate = useNavigate();
	const color = getStatusColor(event);
	const { primary, sub } = getEventText(event);
	const time = timeAgo(event.changedAt);
	const navUrl =
		event.kind === "visit"
			? `/dispatch/jobs/${event.visit.job.id}/visits/${event.visit.id}`
			: `/dispatch/technicians/${event.techId}`;
	const NavIcon = event.kind === "visit" ? Briefcase : User;

	const isPrimary = event.kind === "tech" || event.visitStatusChanged;

	const navButton = (
		<button
			onClick={(e) => {
				e.stopPropagation();
				navigate(navUrl);
			}}
			className="shrink-0 flex items-center gap-0.5 px-1.5 py-1 text-text-tertiary bg-surface/60 border border-border/60 hover:text-primary-text hover:bg-surface hover:border-border-strong rounded transition-colors"
			title={event.kind === "visit" ? "View visit" : "View technician"}
		>
			<NavIcon size={10} />
			<ArrowUpRight size={9} />
		</button>
	);

	if (isPrimary) {
		return (
			<li
				className="my-0.5 rounded-r bg-base/60"
				style={{ borderLeft: `2px solid ${color}` }}
			>
				<div className="flex items-center">
					<div className="flex-1 py-1.5 pl-2.5 pr-1 min-w-0">
						<p className="text-[10px] font-semibold text-text-primary leading-snug">
							{primary}
						</p>
						<p className="text-[9px] text-text-muted mt-0.5">
							{sub ? `${sub} · ${time}` : time}
						</p>
					</div>
					{navButton}
				</div>
			</li>
		);
	}

	return (
		<li className="py-1 px-2 flex items-center gap-1.5">
			<span
				className="w-1.5 h-1.5 rounded-full flex-shrink-0"
				style={{ backgroundColor: color }}
			/>
			<div className="min-w-0 flex-1">
				<p className="text-[10px] text-text-tertiary leading-snug truncate">
					{primary}
				</p>
				<p className="text-[9px] text-text-faint mt-0.5">{time}</p>
			</div>
			{navButton}
		</li>
	);
}
