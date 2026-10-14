import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Building2, Check, EyeOff, LocateFixed, MapPin } from "lucide-react";
import { useNow } from "../../../hooks/useNow";
import { usePermission } from "../../../hooks/usePermission";
import { formatPulseAge, isPingLive } from "../../../lib/livePulse";
import { formatEtaShort } from "../../../lib/mapMarkers";
import type { RecordMapTechRow, VisitTechStatus } from "../../../lib/recordMap";
import { VisitStatusColors, VisitStatusLabels, type VisitStatus } from "../../../types/jobs";
import { TechnicianStatusDotColors, TechnicianStatusLabels } from "../../../types/technicians";
import type { Coordinates } from "../../../types/location";
import { formatShortDate } from "../../../util/util";
import LiveDot from "./LiveDot";

const METERS_PER_MILE = 1609.344;

// Assigned is implied by the row being listed under the visit, so it gets no label.
const VISIT_TECH_LABELS: Record<VisitTechStatus, string | null> = {
	Assigned: null,
	EnRoute: "En route",
	OnSite: "On site",
	Done: "Done",
};

// One anatomy for every rail row: [lead 16px] primary/meta ··· [trailing].
// The lead slot is h-5 so it centres on the primary line; the trailing action
// centres on the whole row so it reads as belonging to the item, not its first line.
export const ROW_GRID =
	"grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-1.5";
const SLOT = "flex h-5 items-center justify-center";
const TRAIL = "flex min-h-5 items-center justify-center self-center";

export interface RailVisit {
	id: string;
	startAt: string | Date;
	name: string;
	status: VisitStatus;
	selected: boolean;
	/** Techs assigned to the visit, including any listed under another selected visit. */
	crewCount?: number;
}

export interface RecordMapRailProps {
	siteLabel: string;
	address: string;
	siteCoords: Coordinates | null;
	techRows: RecordMapTechRow[];
	isLoading: boolean;
	orgName: string | null;
	orgCoords: Coordinates | null;
	orgMissing: boolean;
	onLocate: (c: Coordinates) => void;
	hiddenNote?: string;
	emptyTechText?: string;
	visits?: RailVisit[];
	onToggleVisit?: (id: string) => void;
	tz?: string;
}

function techDetail(row: RecordMapTechRow, now: number): string {
	// Only a stale tech gets an age; the pulsing dot already says "live".
	const age = isPingLive(row.status, row.lastPingAt, now)
		? null
		: formatPulseAge(row.lastPingAt, now);
	if (row.etaSeconds !== null) {
		const miles =
			row.distanceMeters !== null
				? ` · ${(row.distanceMeters / METERS_PER_MILE).toFixed(1)} mi`
				: "";
		return `${formatEtaShort(row.etaSeconds)}${miles}${age ? ` · last seen ${age}` : ""}`;
	}
	if (row.drivingElsewhere) return age ? `En route elsewhere · last seen ${age}` : "En route elsewhere";
	if (!row.coords) return "No location reported";
	return age ? `Last seen ${age}` : "Last reported location";
}

function LocateButton({
	label,
	coords,
	onLocate,
}: {
	label: string;
	coords: Coordinates | null;
	onLocate: (c: Coordinates) => void;
}) {
	return (
		<button
			type="button"
			aria-label={`Show ${label} on map`}
			disabled={!coords}
			onClick={() => coords && onLocate(coords)}
			className="-my-1 flex h-7 w-7 items-center justify-center rounded text-text-tertiary transition-colors duration-150 ease-out hover:bg-surface hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
		>
			<LocateFixed size={14} />
		</button>
	);
}

export function Muted({ children }: { children: ReactNode }) {
	return <p className="px-3 py-1 text-xs text-text-muted">{children}</p>;
}

export function HiddenLine({ text }: { text: string }) {
	return (
		<p className="flex items-center gap-1.5 px-3 py-1 text-xs text-text-muted">
			<EyeOff size={12} aria-hidden="true" className="flex-shrink-0" />
			{text}
		</p>
	);
}

export function TechRow({
	row,
	onLocate,
}: {
	row: RecordMapTechRow;
	onLocate: (c: Coordinates) => void;
}) {
	const now = useNow(10_000);
	return (
		<li className={ROW_GRID}>
			<span className={SLOT}>
				<LiveDot
					status={row.status}
					lastPingAt={row.lastPingAt}
					dotClassName={TechnicianStatusDotColors[row.status]}
					style={row.color ? { backgroundColor: row.color } : undefined}
				/>
			</span>
			<div className="min-w-0">
				<div className="flex min-h-5 items-baseline gap-2 leading-5">
					<Link
						to={`/dispatch/technicians/${row.techId}`}
						className="truncate font-medium text-text-primary transition-colors duration-150 ease-out hover:text-primary-text"
					>
						{row.name}
					</Link>
					{row.visitTechStatus ? (
						VISIT_TECH_LABELS[row.visitTechStatus] && (
							<span className="flex-shrink-0 text-xs text-text-tertiary">
								{VISIT_TECH_LABELS[row.visitTechStatus]}
								<span className="sr-only">
									, {TechnicianStatusLabels[row.status]}
								</span>
							</span>
						)
					) : (
						<span className="flex-shrink-0 text-xs text-text-tertiary">
							{TechnicianStatusLabels[row.status]}
						</span>
					)}
				</div>
				{!row.positionHidden && (
					<p className="text-xs text-text-tertiary">{techDetail(row, now)}</p>
				)}
			</div>
			<span className={TRAIL}>
				{!row.positionHidden && (
					<LocateButton label={row.name} coords={row.coords} onLocate={onLocate} />
				)}
			</span>
		</li>
	);
}

function ZoneHeading({ id, title, count }: { id: string; title: string; count?: string }) {
	return (
		<div className="flex items-baseline justify-between px-3 pt-2.5 pb-0.5">
			<h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
				{title}
			</h3>
			{count && <span className="text-xs text-text-tertiary">{count}</span>}
		</div>
	);
}

function CrewZone({
	techRows,
	isLoading,
	hiddenNote,
	emptyTechText,
	onLocate,
}: Pick<
	RecordMapRailProps,
	"techRows" | "isLoading" | "hiddenNote" | "emptyTechText" | "onLocate"
>) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="pb-1.5">
			<ZoneHeading
				id={id}
				title="Crew"
				count={techRows.length > 0 ? String(techRows.length) : undefined}
			/>
			{hiddenNote && <HiddenLine text={hiddenNote} />}
			{isLoading ? (
				<Muted>Loading…</Muted>
			) : techRows.length === 0 ? (
				<Muted>{emptyTechText ?? "No technicians assigned"}</Muted>
			) : (
				<ul>
					{techRows.map((row) => (
						<TechRow key={row.techId} row={row} onLocate={onLocate} />
					))}
				</ul>
			)}
		</section>
	);
}

// eslint-disable-next-line react-refresh/only-export-components
export function groupCrewByVisit(
	visits: RailVisit[],
	rows: RecordMapTechRow[],
): { byVisit: Map<string, RecordMapTechRow[]>; other: RecordMapTechRow[] } {
	const selected = new Set(visits.filter((v) => v.selected).map((v) => v.id));
	const byVisit = new Map<string, RecordMapTechRow[]>();
	const other: RecordMapTechRow[] = [];
	for (const r of rows) {
		if (r.visitId && selected.has(r.visitId)) {
			byVisit.set(r.visitId, [...(byVisit.get(r.visitId) ?? []), r]);
		} else {
			other.push(r);
		}
	}
	return { byVisit, other };
}

function VisitItem({
	visit,
	crew,
	isLoading,
	tz,
	onToggle,
	onLocate,
}: {
	visit: RailVisit;
	crew: RecordMapTechRow[];
	isLoading: boolean;
	tz: string | undefined;
	onToggle: (id: string) => void;
	onLocate: (c: Coordinates) => void;
}) {
	const label = `${formatShortDate(visit.startAt, tz)} · ${visit.name.trim() || "Visit"}`;
	const on = visit.selected;
	return (
		<li className={on ? "bg-primary/5" : undefined}>
			{/* Only the header line is the checkbox: crew links and Locate buttons
			    below it must stay independently clickable. */}
			<button
				type="button"
				role="checkbox"
				aria-checked={on}
				aria-label={`${label}, ${VisitStatusLabels[visit.status]}`}
				onClick={() => onToggle(visit.id)}
				className={`${ROW_GRID} w-full text-left transition-colors duration-150 ease-out focus-visible:outline-offset-[-2px]! ${
					on ? "" : "hover:bg-surface"
				}`}
			>
				<span className={SLOT}>
					<span
						aria-hidden="true"
						className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-colors duration-150 ease-out ${
							on ? "border-primary bg-primary text-on-primary" : "border-border-strong"
						}`}
					>
						{on && <Check size={10} strokeWidth={3} />}
					</span>
				</span>
				<span
					title={label}
					className={`line-clamp-2 break-words font-medium leading-5 ${
						on ? "text-text-primary" : "text-text-tertiary"
					}`}
				>
					{label}
				</span>
				<span className="flex h-5 items-center">
					<span
						className={`rounded border px-1.5 py-0.5 text-[10px] leading-none ${VisitStatusColors[visit.status]}`}
					>
						{VisitStatusLabels[visit.status]}
					</span>
				</span>
			</button>
			{on && (
				<div className="pb-0.5 pl-6">
					{isLoading ? (
						<Muted>Loading…</Muted>
					) : crew.length === 0 ? (
						<Muted>
							{visit.crewCount
								? "Crew shown under another visit"
								: "No technicians assigned"}
						</Muted>
					) : (
						<ul>
							{crew.map((row) => (
								<TechRow key={row.techId} row={row} onLocate={onLocate} />
							))}
						</ul>
					)}
					{crew.some((r) => r.positionHidden) && (
						<HiddenLine text="Closed visit — live position hidden" />
					)}
				</div>
			)}
		</li>
	);
}

function VisitsZone({
	visits,
	techRows,
	isLoading,
	emptyTechText,
	tz,
	onToggleVisit,
	onLocate,
}: {
	visits: RailVisit[];
	techRows: RecordMapTechRow[];
	isLoading: boolean;
	emptyTechText?: string;
	tz?: string;
	onToggleVisit: (id: string) => void;
	onLocate: (c: Coordinates) => void;
}) {
	const id = useId();
	const { byVisit, other } = groupCrewByVisit(visits, techRows);
	const selectedCount = visits.filter((v) => v.selected).length;
	return (
		<section aria-labelledby={id} className="pb-1.5">
			<ZoneHeading
				id={id}
				title="Visits"
				count={visits.length > 0 ? `${selectedCount} of ${visits.length}` : undefined}
			/>
			{visits.length === 0 ? (
				<Muted>This job has no visits yet.</Muted>
			) : (
				<ul>
					{visits.map((v) => (
						<VisitItem
							key={v.id}
							visit={v}
							crew={byVisit.get(v.id) ?? []}
							isLoading={isLoading}
							tz={tz}
							onToggle={onToggleVisit}
							onLocate={onLocate}
						/>
					))}
				</ul>
			)}
			{visits.length > 0 && selectedCount === 0 && (
				<Muted>{emptyTechText ?? "Select a visit to see its crew"}</Muted>
			)}
			{other.length > 0 && (
				<div className="mt-1 border-t border-border-subtle">
					<h4 className="px-3 pt-1.5 text-xs font-medium text-text-secondary">Other visits</h4>
					<ul>
						{other.map((row) => (
							<TechRow key={row.techId} row={row} onLocate={onLocate} />
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

export default function RecordMapRail(props: RecordMapRailProps) {
	const { siteLabel, address, siteCoords, orgName, orgCoords, orgMissing, onLocate } = props;
	const canManageOrg = usePermission("manage_organization");

	return (
		<aside
			aria-label="Map details"
			className="flex min-w-0 flex-col text-sm lg:h-[560px] lg:overflow-hidden lg:rounded-lg lg:border lg:border-border-subtle"
		>
			<section aria-label="Site" className="flex-shrink-0 border-b border-border-subtle">
				<div className={ROW_GRID}>
					<span className={SLOT}>
						<MapPin size={14} className="text-primary-text" />
					</span>
					<div className="min-w-0">
						<p className="truncate font-medium leading-5 text-text-primary" title={siteLabel}>
							{siteLabel}
						</p>
						<p className="break-words text-xs text-text-tertiary">{address}</p>
					</div>
					<span className={TRAIL}>
						<LocateButton label={siteLabel} coords={siteCoords} onLocate={onLocate} />
					</span>
				</div>
			</section>

			{/* Only the middle zone scrolls, so site and office never leave view. */}
			<div className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
				{props.visits ? (
					<VisitsZone
						visits={props.visits}
						techRows={props.techRows}
						isLoading={props.isLoading}
						emptyTechText={props.emptyTechText}
						tz={props.tz}
						onToggleVisit={props.onToggleVisit ?? (() => {})}
						onLocate={onLocate}
					/>
				) : (
					<CrewZone
						techRows={props.techRows}
						isLoading={props.isLoading}
						hiddenNote={props.hiddenNote}
						emptyTechText={props.emptyTechText}
						onLocate={onLocate}
					/>
				)}
			</div>

			<section aria-label="Office" className="flex-shrink-0 border-t border-border-subtle">
				<div className={ROW_GRID}>
					<span className={SLOT}>
						<Building2 size={14} className="text-text-tertiary" />
					</span>
					<div className="min-w-0">
						{orgMissing ? (
							<>
								<p className="leading-5 text-text-muted">No office address on file</p>
								{canManageOrg && (
									<Link
										to="/dispatch/admin?tab=settings"
										className="text-xs text-primary-text hover:underline"
									>
										Set office address
									</Link>
								)}
							</>
						) : (
							<>
								<p className="truncate leading-5 text-text-secondary">
									{orgName ?? "Office"}
								</p>
								<p className="text-xs text-text-tertiary">Office</p>
							</>
						)}
					</div>
					<span className={TRAIL}>
						{!orgMissing && orgName && (
							<LocateButton label={orgName} coords={orgCoords} onLocate={onLocate} />
						)}
					</span>
				</div>
			</section>
		</aside>
	);
}
