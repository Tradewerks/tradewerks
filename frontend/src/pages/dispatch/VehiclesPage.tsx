import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Wrench } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useVehiclesQuery, useCreateVehicleMutation } from "../../hooks/useVehicles";
import { useMaintenanceAlertsQuery } from "../../hooks/useVehicleStock";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import VehicleCard from "../../components/vehicles/VehicleCard";
import { getStockHealth } from "../../components/vehicles/stockHealth";
import VehicleAlertsSidebar from "../../components/vehicles/VehicleAlertsSidebar";
import VehicleReadinessPanel from "../../components/vehicles/VehicleReadinessPanel";
import CreateVehicle from "../../components/vehicles/CreateVehicle";
import EditVehicle from "../../components/vehicles/EditVehicle";
import type { Vehicle, VehicleReadiness } from "../../types/vehicles";
import { getFleetReadiness } from "../../api/vehicles";
import { qk } from "../../lib/queryKeys";
import LoadSvg from "../../assets/icons/loading.svg?react";
import BoxSvg from "../../assets/icons/box.svg?react";
import ErrSvg from "../../assets/icons/error.svg?react";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";

/**
 * Fleet pulse — proportional health bar + clickable count filters.
 * Replaces the old Stock dropdown: state is visible, filtering is one click.
 */
function FleetPulse({
	vehicles,
	stockFilter,
	onFilter,
	readyCount,
	relevantCount,
	selectedDate,
	setSelectedDate,
	overdueCount,
	dueSoonCount,
}: {
	vehicles: Vehicle[];
	stockFilter: string | null;
	onFilter: (f: string | null) => void;
	readyCount: number;
	relevantCount: number;
	selectedDate: string;
	setSelectedDate: (d: string) => void;
	overdueCount: number;
	dueSoonCount: number;
}) {
	let out = 0;
	let low = 0;
	let ok = 0;
	for (const v of vehicles) {
		const h = getStockHealth(v);
		if (h === "out") out++;
		else if (h === "low") low++;
		else ok++;
	}
	const total = vehicles.length;
	const issues = out + low;

	const chip = (active: boolean, tone: "neutral" | "error" | "warning") => {
		if (active) {
			return tone === "error"
				? "bg-error/15 text-error-text border-error/40"
				: tone === "warning"
					? "bg-warning/15 text-warning-text border-warning/40"
					: "bg-primary-bg text-primary-text border-primary-border";
		}
		return "bg-transparent text-text-muted border-transparent hover:text-text-secondary hover:bg-surface-raised";
	};

	return (
		<div className="flex items-center justify-between gap-4 mb-3 px-4 py-2.5 bg-surface border border-border-card rounded-lg">
			<div className="flex items-center gap-3 min-w-0">
				{/* Proportional fleet bar */}
				<div className="flex h-2 w-32 rounded-full overflow-hidden bg-surface-inset flex-shrink-0">
					{out > 0 && <div className="bg-error h-full" style={{ flexGrow: out, flexBasis: 0 }} />}
					{low > 0 && <div className="bg-warning h-full" style={{ flexGrow: low, flexBasis: 0 }} />}
					{ok > 0 && <div className="bg-success/70 h-full" style={{ flexGrow: ok, flexBasis: 0 }} />}
					{total === 0 && <div className="bg-surface-inset h-full w-full" />}
				</div>

				{/* Count filters */}
				<div className="flex items-center gap-1 text-xs font-semibold" title="Stock Alerts">
					<button
						onClick={() => onFilter(null)}
						className={`px-2 py-0.5 rounded border transition-colors ${chip(stockFilter === null, "neutral")}`}
					>
						All {total}
					</button>
					<button
						onClick={() => onFilter(stockFilter === "out" ? null : "out")}
						disabled={out === 0}
						className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${chip(stockFilter === "out", "error")}`}
					>
						{out} out
					</button>
					<button
						onClick={() => onFilter(stockFilter === "low" ? null : "low")}
						disabled={issues === 0}
						className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${chip(stockFilter === "low", "warning")}`}
					>
						{low} low
					</button>
					<button
						onClick={() => onFilter(stockFilter === "issues" ? null : "issues")}
						disabled={issues === 0}
						className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${chip(stockFilter === "issues", "warning")}`}
					>
						{issues} with issues
					</button>
				</div>

				<div className="w-px h-4 bg-border-subtle flex-shrink-0" />

				<div className="flex items-center gap-1 text-xs font-semibold" title="Vehicle Maintenance Reminders">
					<Wrench size={12} className="text-text-muted flex-shrink-0" />
					<button
						onClick={() => onFilter(stockFilter === "maintenance-overdue" ? null : "maintenance-overdue")}
						disabled={overdueCount === 0}
						className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${chip(stockFilter === "maintenance-overdue", "error")}`}
					>
						{overdueCount} overdue
					</button>
					<button
						onClick={() => onFilter(stockFilter === "maintenance-duesoon" ? null : "maintenance-duesoon")}
						disabled={dueSoonCount === 0}
						className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${chip(stockFilter === "maintenance-duesoon", "warning")}`}
					>
						{dueSoonCount} due soon
					</button>
				</div>
			</div>

			{/* Readiness summary + day toggle */}
			<div className="flex items-center gap-3 flex-shrink-0">
				{relevantCount > 0 && (
					<span className="text-xs text-text-muted">
						<span className={`font-semibold ${readyCount === relevantCount ? "text-success" : "text-text-secondary"}`}>
							{readyCount}/{relevantCount}
						</span>{" "}
						ready
					</span>
				)}
				<div className="flex rounded border border-border overflow-hidden text-xs font-semibold">
					{(["today", "tomorrow"] as const).map((label) => {
						const d = new Date();
						if (label === "tomorrow") d.setUTCDate(d.getUTCDate() + 1);
						const dateStr = d.toISOString().slice(0, 10);
						const isActive = selectedDate === dateStr;
						return (
							<button
								key={label}
								onClick={() => setSelectedDate(dateStr)}
								className={`px-3 py-1 capitalize transition-colors ${
									isActive
										? "bg-primary text-on-primary"
										: "text-text-muted hover:text-text-secondary"
								} ${label === "tomorrow" ? "border-l border-border" : ""}`}
							>
								{label}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export default function VehiclesPage() {
	const [pageSearchParams, setPageSearchParams] = useSearchParams();
	const [searchInput, setSearchInput] = useState("");
	const [stockFilter, setStockFilter] = useState<string | null>(null);
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);

	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");

	const raw = pageSearchParams.get("status");
	const statusParam = raw === "active" || raw === "inactive" ? raw : null;

	const clearStatus = () => {
		const next = new URLSearchParams(pageSearchParams);
		next.delete("status");
		setPageSearchParams(next);
	};

	const { data: vehicles, isLoading, error } = useVehiclesQuery(statusParam ?? undefined);
	const { data: maintenanceAlerts = [] } = useMaintenanceAlertsQuery();
	const { mutateAsync: createVehicle } = useCreateVehicleMutation();

	const [selectedDate, setSelectedDate] = useState<string>(
		() => new Date().toISOString().slice(0, 10)
	);
	const [readinessPanelVehicleId, setReadinessPanelVehicleId] = useState<string | null>(null);

	// One batched request for the whole fleet (was a per-vehicle query fan-out)
	const { data: fleetReadiness = [] } = useQuery({
		queryKey: qk.fleetReadiness(selectedDate),
		queryFn: () => getFleetReadiness(selectedDate),
		staleTime: 30_000,
		enabled: (vehicles?.length ?? 0) > 0,
	});

	const readinessMap = new Map<string, VehicleReadiness>(
		fleetReadiness.map((r) => [r.vehicle_id, r]),
	);

	const relevantCount = [...readinessMap.values()].filter(
		(r) => r.state !== "not_applicable"
	).length;

	const readyCount = [...readinessMap.values()].filter(
		(r) => r.state === "auto_ready" || r.state === "confirmed"
	).length;

	const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

	const MANAGE_VEHICLES = usePermission("manage_inventory");

	const openAlerts = maintenanceAlerts.filter((a) => !a.acknowledged);
	const overdueVehicleIds = new Set(openAlerts.filter((a) => a.status === "overdue").map((a) => a.vehicleId));
	const dueSoonVehicleIds = new Set(openAlerts.filter((a) => a.status === "duesoon").map((a) => a.vehicleId));

	const filteredVehicles = vehicles?.filter((v) => {
		if (activeTerms.length > 0) {
			const matchesTerms = activeTerms.every((term) => {
				const lower = term.toLowerCase();
				return (
					v.name.toLowerCase().includes(lower) ||
					v.type.toLowerCase().includes(lower) ||
					(v.license_plate?.toLowerCase().includes(lower) ?? false)
				);
			});
			if (!matchesTerms) return false;
		}
		if (stockFilter) {
			const health = getStockHealth(v);
			if (stockFilter === "out" && health !== "out") return false;
			if (stockFilter === "low" && health === "ok") return false;
			if (stockFilter === "issues" && health === "ok") return false;
			if (stockFilter === "maintenance-overdue" && !overdueVehicleIds.has(v.id)) return false;
			if (stockFilter === "maintenance-duesoon" && !dueSoonVehicleIds.has(v.id)) return false;
		}
		return true;
	});

	return (
		<div className="flex h-full text-text-primary">
			<div className="flex-1 flex flex-col min-h-0 mr-7">
				<PageHeader title="Vehicles">
					{MANAGE_VEHICLES && (
						<button
							onClick={() => setIsCreateModalOpen(true)}
							className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							<Plus size={16} />
							New Vehicle
						</button>
					)}
				</PageHeader>

				<PageControls
					className="mb-4"
					left={
						<SearchBar
							paramKey="search"
							placeholder="Search by name, type, or plate…"
							onValueChange={setSearchInput}
							onSubmit={addTerm}
						/>
					}
					middle={
						<StatusFilter
							paramKey="status"
							placeholder="Status"
							options={[
								{ value: "active", label: "Active" },
								{ value: "inactive", label: "Inactive" },
							]}
						/>
					}
				/>

				<FilterChips
					filters={[
						statusParam
							? {
									label: `Status: ${statusParam === "active" ? "Active" : "Inactive"}`,
									color: "green" as const,
									onRemove: clearStatus,
							  }
							: null,
						...terms.map((term) => ({
							label: `Search: "${term}"`,
							color: "purple" as const,
							onRemove: () => removeTerm(term),
							highlighted: duplicateTerm === term,
						})),
					]}
					resultCount={filteredVehicles?.length ?? 0}
					onClearAll={() => {
						setSearchInput("");
						const next = new URLSearchParams(pageSearchParams);
						next.delete("search");
						next.delete("status");
						setPageSearchParams(next);
					}}
				/>

				{!isLoading && !error && (vehicles?.length ?? 0) > 0 && (
					<FleetPulse
						vehicles={vehicles ?? []}
						stockFilter={stockFilter}
						onFilter={setStockFilter}
						readyCount={readyCount}
						relevantCount={relevantCount}
						selectedDate={selectedDate}
						setSelectedDate={setSelectedDate}
						overdueCount={overdueVehicleIds.size}
						dueSoonCount={dueSoonVehicleIds.size}
					/>
				)}

				{/* Loading */}
				{isLoading && (
					<div className="w-full h-[400px] flex flex-col justify-center items-center">
						<LoadSvg className="w-12 h-12 mb-3" />
						<h1 className="text-center text-xl mt-3">Please wait...</h1>
					</div>
				)}

				{/* Error */}
				{error && !isLoading && (
					<div className="w-full h-[400px] flex flex-col justify-center items-center">
						<ErrSvg className="w-15 h-15 mb-1" />
						<h1 className="text-center text-xl mt-1">An error has occurred.</h1>
						<h2 className="text-center text-text-muted mt-1">{error.message}</h2>
					</div>
				)}

				{/* Empty */}
				{!isLoading && !error && filteredVehicles?.length === 0 && (
					<div className="w-full h-[400px] flex flex-col justify-center items-center">
						<BoxSvg className="w-15 h-15 mb-1" />
						<h1 className="text-center text-xl mt-1">
							{activeTerms.length > 0 || stockFilter ? "No vehicles found." : "No vehicles yet."}
						</h1>
						{(activeTerms.length > 0 || stockFilter) && (
							<p className="text-center text-text-muted mt-2">
								{stockFilter ? "No vehicles match this stock filter." : "Try adjusting your search terms."}
							</p>
						)}
					</div>
				)}

				{/* List */}
				{!isLoading && !error && filteredVehicles && filteredVehicles.length > 0 && (
					<div className="flex flex-col">
						{/* Column header row */}
						<div className="grid grid-cols-[1fr_150px_176px_110px_168px] gap-3 px-5 py-1.5 border-b border-border/30">
							{["Vehicle", "Technician", "Stock", "Readiness", ""].map((h) => (
								<div key={h} className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{h}</div>
							))}
						</div>
						{filteredVehicles.map((vehicle) => (
							<VehicleCard
								key={vehicle.id}
								vehicle={vehicle}
								onEdit={(v) => { setSelectedVehicle(v); setIsEditModalOpen(true); }}
								readiness={readinessMap.get(vehicle.id)}
								onReadinessClick={() => setReadinessPanelVehicleId(vehicle.id)}
							/>
						))}
					</div>
				)}

				<CreateVehicle
					isModalOpen={isCreateModalOpen}
					setIsModalOpen={setIsCreateModalOpen}
					createVehicle={async (input) => {
						const v = await createVehicle(input);
						return v.id;
					}}
				/>

				{selectedVehicle && (
					<EditVehicle
						isOpen={isEditModalOpen}
						onClose={() => {
							setIsEditModalOpen(false);
							setSelectedVehicle(null);
						}}
						vehicle={selectedVehicle}
					/>
				)}
			</div>
			<VehicleAlertsSidebar />
			{readinessPanelVehicleId && (() => {
				const panelVehicle = (vehicles ?? []).find((v) => v.id === readinessPanelVehicleId);
				const panelReadiness = readinessMap.get(readinessPanelVehicleId);
				if (!panelVehicle || !panelReadiness) return null;
				return (
					<>
						<div
							className="fixed inset-0 z-40 bg-overlay"
							onClick={() => setReadinessPanelVehicleId(null)}
						/>
						<VehicleReadinessPanel
							vehicle={panelVehicle}
							readiness={panelReadiness}
							date={selectedDate}
							onClose={() => setReadinessPanelVehicleId(null)}
						/>
					</>
				);
			})()}
		</div>
	);
}
