import { useState, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Plus, ChevronRight } from "lucide-react";
import { useAllTechniciansQuery, useCreateTechnicianMutation } from "../../hooks/useTechnicians";
import CreateTechnician from "../../components/technicians/CreateTechnician";
import EditTechnician from "../../components/technicians/EditTechnician";
import TechnicianCard from "../../components/technicians/TechnicianCard";
import { TECH_COL_VISIBILITY, TECH_ROW_COLS } from "../../components/technicians/technicianRosterLayout";
import LoadSvg from "../../assets/icons/loading.svg?react";
import BoxSvg from "../../assets/icons/box.svg?react";
import ErrSvg from "../../assets/icons/error.svg?react";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import ViewToggle from "../../components/ui/ViewToggle";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import PageHeader from "../../components/ui/PageHeader";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import {
	TechnicianStatusColors,
	TechnicianStatusDotColors,
	TechnicianStatusLabels,
	type Technician,
	type TechnicianStatus,
} from "../../types/technicians";

type viewMode = "list" | "card";
type GroupId = "active" | "available" | "break" | "offline" | "inactive";

const technicianStatusOptions = [
	{ value: "Available", label: "Available" },
	{ value: "Working", label: "Working" },
	{ value: "EnRoute", label: "En Route" },
	{ value: "OnSite", label: "On Site" },
	{ value: "Paused", label: "Paused" },
	{ value: "WrappingUp", label: "Wrapping Up" },
	{ value: "HeadingBack", label: "Heading Back" },
	{ value: "Break", label: "Break" },
	{ value: "Offline", label: "Offline" },
];

const STATUS_ORDER: TechnicianStatus[] = [
	"Working",
	"EnRoute",
	"OnSite",
	"Paused",
	"WrappingUp",
	"HeadingBack",
	"Available",
	"Break",
	"Offline",
];

const GROUPS: { id: GroupId; label: string; statuses: TechnicianStatus[] }[] = [
	{ id: "active", label: "On the job", statuses: ["Working", "EnRoute", "OnSite", "Paused", "WrappingUp", "HeadingBack"] },
	{ id: "available", label: "Available", statuses: ["Available"] },
	{ id: "break", label: "On break", statuses: ["Break"] },
	{ id: "offline", label: "Offline", statuses: ["Offline"] },
	{ id: "inactive", label: "Inactive", statuses: [] },
];

const STORAGE = {
	view: "dispatch.technicians.view",
	collapsed: "dispatch.technicians.collapsed",
};

function readStored<T>(key: string, fallback: T, isValid: (v: unknown) => v is T): T {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		const parsed: unknown = JSON.parse(raw);
		return isValid(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function writeStored(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode / blocked storage — the preference just won't persist.
	}
}

const isView = (v: unknown): v is viewMode => v === "list" || v === "card";
const isGroupList = (v: unknown): v is GroupId[] =>
	Array.isArray(v) && v.every((g) => GROUPS.some((group) => group.id === g));

export default function TechniciansPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const {
		data: technicians,
		isLoading: isFetchLoading,
		error: fetchError,
	} = useAllTechniciansQuery();
	const { mutateAsync: createTechnician } = useCreateTechnicianMutation();
	const [searchInput, setSearchInput] = useState("");
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editing, setEditing] = useState<Technician | null>(null);
	const [viewMode, setViewModeState] = useState<viewMode>(() =>
		readStored(STORAGE.view, "list", isView)
	);
	const [collapsed, setCollapsed] = useState<GroupId[]>(() =>
		readStored(STORAGE.collapsed, ["offline", "inactive"], isGroupList)
	);

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");

	const queryParams = new URLSearchParams(location.search);
	const statusFilter = queryParams.getAll("status");
	const { addTerm: addStatus, removeTerm: removeStatus } = useMultiSearch("status");

	// permissions
	const MANAGE_TECHNICIANS = usePermission("manage_technicians");

	const setViewMode = (v: viewMode) => {
		setViewModeState(v);
		writeStored(STORAGE.view, v);
	};
	const toggleGroup = (id: GroupId) => {
		const next = collapsed.includes(id) ? collapsed.filter((g) => g !== id) : [...collapsed, id];
		setCollapsed(next);
		writeStored(STORAGE.collapsed, next);
	};
	const toggleStatus = (s: TechnicianStatus) => {
		if (statusFilter.includes(s)) removeStatus(s);
		else addStatus(s);
	};

	const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
	const isFiltered = activeTerms.length > 0 || statusFilter.length > 0;

	const statusKey = statusFilter.join(",");
	const activeKey = JSON.stringify(activeTerms);
	const filteredTechnicians = useMemo(
		() =>
			technicians
				?.filter((tech) => {
					if (activeTerms.length > 0) {
						const matches = activeTerms.every((term) => {
							const lower = term.toLowerCase();
							return (
								tech.name.toLowerCase().includes(lower) ||
								(tech.email?.toLowerCase().includes(lower) ?? false) ||
								(tech.phone?.toLowerCase().includes(lower) ?? false) ||
								(tech.title?.toLowerCase().includes(lower) ?? false)
							);
						});
						if (!matches) return false;
					}
					if (statusFilter.length > 0)
						return statusFilter.some(
							(s) => s.toLowerCase() === tech.status.toLowerCase()
						);
					return true;
				})
				.sort((a, b) => {
					const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
					return byStatus !== 0 ? byStatus : a.name.localeCompare(b.name);
				}) ?? [],
		// Keyed on serialized filters: activeTerms/statusFilter are fresh arrays every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[technicians, activeKey, statusKey]
	);

	const groups = useMemo(
		() =>
			GROUPS.map((group) => ({
				...group,
				members: filteredTechnicians.filter((t) =>
					group.id === "inactive"
						? !!t.deactivated_at
						: !t.deactivated_at && group.statuses.includes(t.status)
				),
			})).filter((group) => group.members.length > 0),
		[filteredTechnicians]
	);

	const statusCounts = useMemo(
		() =>
			(technicians ?? []).reduce(
				(acc, t) => {
					if (t.deactivated_at) return acc;
					acc[t.status] = (acc[t.status] || 0) + 1;
					return acc;
				},
				{} as Partial<Record<TechnicianStatus, number>>
			),
		[technicians]
	);

	const renderMembers = (members: Technician[]) =>
		members.map((technician) => (
			<TechnicianCard
				key={technician.id}
				technician={technician}
				onClick={() => navigate(`/dispatch/technicians/${technician.id}`)}
				onEdit={setEditing}
				viewMode={viewMode}
				rowStyle="roster"
			/>
		));

	const groupHeader = (group: (typeof groups)[number], isCollapsed: boolean) => (
		<button
			type="button"
			onClick={() => toggleGroup(group.id)}
			aria-expanded={!isCollapsed}
			aria-controls={`tech-group-${group.id}`}
			className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-text-tertiary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
		>
			<ChevronRight
				size={14}
				aria-hidden
				className={`transition-transform duration-150 ease-out ${isCollapsed ? "" : "rotate-90"}`}
			/>
			{group.label}
			<span className="font-medium tabular-nums text-text-muted">{group.members.length}</span>
		</button>
	);

	return (
		<div className="text-text-primary">
			<PageHeader
				title="Technicians"
				subtitle={
					<div
						className="flex flex-wrap gap-1 text-xs"
						role="group"
						aria-label="Filter by status"
					>
						{technicianStatusOptions.map(({ value }) => {
							const status = value as TechnicianStatus;
							const count = statusCounts[status] ?? 0;
							const pressed = statusFilter.includes(status);
							return (
								<button
									key={status}
									type="button"
									onClick={() => toggleStatus(status)}
									aria-pressed={pressed}
									className={`items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
										pressed
											? "bg-surface text-text-primary ring-1 ring-border-strong"
											: "text-text-secondary"
									} ${count === 0 && !pressed ? "hidden opacity-50 sm:flex" : "flex"}`}
								>
									<span
										aria-hidden
										className={`h-2 w-2 rounded-full ${TechnicianStatusDotColors[status]}`}
									/>
									{TechnicianStatusLabels[status]}
									<span className="tabular-nums text-text-tertiary">{count}</span>
								</button>
							);
						})}
					</div>
				}
			>
					<button
						title={!MANAGE_TECHNICIANS ? "You don't have permission to perform this action" : undefined}
						disabled={!MANAGE_TECHNICIANS}
						className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						onClick={() => {
							if (!MANAGE_TECHNICIANS) return;
							setIsModalOpen(true);
						}}
					>
						<Plus size={16} />
						New Technician
					</button>
			</PageHeader>
			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search technicians..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<StatusFilter
						paramKey="status"
						placeholder="Status"
						options={technicianStatusOptions}
					/>
				}
				right={<ViewToggle value={viewMode} onChange={setViewMode} />}
			/>

			{/*Filter Bar with Chips*/}
			<FilterChips
				filters={[
					...statusFilter.map((s) => ({
						label: `Status: ${technicianStatusOptions.find((o) => o.value === s)?.label ?? s}`,
						color: "green" as const,
						classes: TechnicianStatusColors[s as TechnicianStatus],
						onRemove: () => removeStatus(s),
					})),
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
				]}
				resultCount={filteredTechnicians.length}
				onClearAll={() => {
					setSearchInput("");
					const next = new URLSearchParams(location.search);
					next.delete("search");
					next.delete("status");
					navigate(`/dispatch/technicians${next.toString() ? `?${next.toString()}` : ""}`);
				}}
			/>

			{/* Loading State */}
			{isFetchLoading && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<LoadSvg className="w-12 h-12 mb-3" />
					<h1 className="text-center text-xl mt-3">Please wait...</h1>
				</div>
			)}

			{/* Error State */}
			{fetchError && !isFetchLoading && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<ErrSvg className="w-15 h-15 mb-1" />
					<h1 className="text-center text-xl mt-1">
						An error has occurred.
					</h1>
					<h2 className="text-center text-text-muted mt-1">
						{fetchError.message}
					</h2>
				</div>
			)}

			{/* Empty State */}
			{!isFetchLoading && !fetchError && filteredTechnicians.length === 0 && (
				<div className="w-full h-[400px] flex flex-col justify-center items-center">
					<BoxSvg className="w-15 h-15 mb-1" />
					<h1 className="text-center text-xl mt-1">
						{isFiltered ? "No technicians found." : "No technicians yet."}
					</h1>
					{isFiltered && (
						<p className="text-center text-text-muted mt-2">
							Try adjusting your search or status filters
						</p>
					)}
				</div>
			)}

			{/* Roster */}
			{!isFetchLoading && !fetchError && filteredTechnicians.length > 0 && viewMode === "list" && (
				// No overflow-hidden here: it would clip the row action menus.
				<div className="mb-6 rounded-lg border border-border bg-base">
					{/* -top-6 cancels the layout scroller's md:pt-6, which otherwise leaves a gap rows show through. */}
					<div className="sticky -top-6 z-10 hidden rounded-t-lg border-b border-border bg-surface md:block">
						<div
							className={`${TECH_ROW_COLS} px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary`}
						>
							<span>Technician</span>
							<span className={TECH_COL_VISIBILITY.status}>Status</span>
							<span className={TECH_COL_VISIBILITY.vehicle}>Vehicle</span>
							<span className={TECH_COL_VISIBILITY.now}>Now</span>
							<span className={TECH_COL_VISIBILITY.today}>Visits today</span>
							<span className={TECH_COL_VISIBILITY.contact}>Contact</span>
							<span className={TECH_COL_VISIBILITY.lastLogin}>Last login</span>
							<span className="sr-only">Actions</span>
						</div>
					</div>
					{groups.map((group) => {
						const isCollapsed = collapsed.includes(group.id);
						return (
							<section
								key={group.id}
								aria-label={group.label}
								className="border-b border-border-subtle last:border-b-0"
							>
								{groupHeader(group, isCollapsed)}
								{!isCollapsed && (
									<div id={`tech-group-${group.id}`} className="border-t border-border-subtle">
										{renderMembers(group.members)}
									</div>
								)}
							</section>
						);
					})}
				</div>
			)}

			{!isFetchLoading && !fetchError && filteredTechnicians.length > 0 && viewMode === "card" && (
				// One continuous grid, already status-sorted: per-group rows strand a lone card
				// per status and leave most of the width empty. Each card's pill carries status.
				<div className="mb-6 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
					{renderMembers(filteredTechnicians)}
				</div>
			)}

			{/* Keyed so the modal's form state initialises from the tech being edited. */}
			{editing && (
				<EditTechnician
					key={editing.id}
					isOpen
					onClose={() => setEditing(null)}
					technician={editing}
				/>
			)}
			<CreateTechnician
				isModalOpen={isModalOpen}
				setIsModalOpen={setIsModalOpen}
				createTechnician={async (input) => {
					const newTechnician = await createTechnician(input);

					if (!newTechnician?.id)
						throw new Error(
							"Technician creation failed: no ID returned"
						);

					return newTechnician.id;
				}}
			/>
		</div>
	);
}
