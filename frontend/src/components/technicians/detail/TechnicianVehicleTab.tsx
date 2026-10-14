import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Package, Truck, Wrench } from "lucide-react";
import Card from "../../ui/Card";
import { NAV_BUTTON, NAV_BUTTON_SM } from "./navButtons";
import { useAnyPermission } from "../../../hooks/usePermission";
import {
	useVehicleMaintenanceReminderQuery,
	useVehicleReadinessQuery,
	useVehicleRecord,
} from "../../../hooks/useVehicles";
import { useVehicleStockQuery } from "../../../hooks/useVehicleStock";
import {
	dueFor,
	STATUS_CLASSNAME,
	STATUS_LABEL,
	STATUS_RANK,
} from "../../../util/vehicleMaintenanceStatus";
import type { Technician } from "../../../types/technicians";
import type { VehicleReadiness } from "../../../types/vehicles";
import { lowStockRows, LOW_STOCK_SHOWN } from "../technicianSchedule";
import { initials, vehicleSpec } from "../technicianFormat";

const READINESS_COPY: Record<VehicleReadiness["state"], string> = {
	confirmed: "Confirmed ready",
	auto_ready: "Ready — stock covers today's visits",
	needs_action: "Short for today's visits",
	unknown: "Readiness unknown",
	not_applicable: "No stocked parts needed today",
};

function Panel({ children }: { children: ReactNode }) {
	return (
		<div
			role="tabpanel"
			id="tabpanel-vehicle"
			aria-labelledby="tab-vehicle"
			className="mt-6 space-y-4"
		>
			<h2 className="sr-only">Vehicle</h2>
			{children}
		</div>
	);
}

function PermissionLine({ children }: { children: ReactNode }) {
	return <p className="text-sm text-text-muted">{children}</p>;
}

export default function TechnicianVehicleTab({ technician }: { technician: Technician }) {
	// Mirrors the backend route gates: readiness is inventory-scoped, while stock,
	// reminders and the vehicle list (odometer) are vehicle-scoped.
	const canReadiness = useAnyPermission(["view_inventory", "manage_technicians"]);
	const canVehicle = useAnyPermission(["view_vehicles", "manage_vehicles", "use_vehicles"]);
	const assignedId = technician.current_vehicle_id ?? undefined;
	// Every hook below idles on an undefined id, so a missing permission never fires a request.
	const readiness = useVehicleReadinessQuery(canReadiness ? assignedId : undefined);
	const vehicleQueryId = canVehicle ? assignedId : undefined;
	const stock = useVehicleStockQuery(vehicleQueryId);
	const reminders = useVehicleMaintenanceReminderQuery(vehicleQueryId);
	const record = useVehicleRecord(vehicleQueryId);
	const odometer = record?.current_odometer_mi ?? null;

	if (!canReadiness && !canVehicle) {
		return (
			<Panel>
				<Card title="Vehicle">
					<PermissionLine>
						Needs the View Vehicles or View Inventory
						permission.
					</PermissionLine>
				</Card>
			</Panel>
		);
	}
	if (!assignedId || !technician.current_vehicle) {
		return (
			<Panel>
				<Card title="Vehicle">
					<p className="text-sm text-text-muted">
						No vehicle assigned
					</p>
					{/* The vehicles list is inventory-gated like the stock page. */}
					{canReadiness && (
						<div className="mt-3">
							<Link
								to="/dispatch/vehicles"
								className={NAV_BUTTON}
							>
								<Truck size={14} aria-hidden /> Go
								to Vehicles
							</Link>
						</div>
					)}
				</Card>
			</Panel>
		);
	}

	const allLow = lowStockRows(stock.data ?? [], Infinity);
	const low = allLow.slice(0, LOW_STOCK_SHOWN);
	const due = (reminders.data ?? [])
		.map((r) => ({ r, d: dueFor(r, odometer) }))
		.filter(({ d }) => d.status === "overdue" || d.status === "duesoon")
		.sort(
			(a, b) =>
				STATUS_RANK[a.d.status] - STATUS_RANK[b.d.status] ||
				a.d.urgency - b.d.urgency
		);

	// The vehicle page is routed behind the inventory gate, and its own data behind
	// the vehicle gate — a link is only useful when both hold.
	const canOpen = canVehicle && canReadiness;
	const vehicleHref = `/dispatch/vehicles/${assignedId}/stock`;
	const vehicle = technician.current_vehicle;
	const specLine = [
		vehicleSpec(record ?? vehicle),
		record?.license_plate ?? vehicle.license_plate,
		odometer != null ? `${odometer.toLocaleString()} mi` : null,
	]
		.filter(Boolean)
		.join(" · ");
	const coDrivers = (record?.current_technicians ?? []).filter((t) => t.id !== technician.id);

	return (
		<Panel>
			<div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border-subtle bg-base px-4 py-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<span
						aria-hidden
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-tertiary"
					>
						<Truck size={18} />
					</span>
					<div className="min-w-0">
						<p className="truncate font-medium text-text-primary">
							{vehicle.name}
						</p>
						{specLine && (
							<p className="truncate text-xs tabular-nums text-text-muted">
								{specLine}
							</p>
						)}
					</div>
				</div>
				{/* Who else stocks from and restocks this truck — without it a
				    dispatcher reading low stock can't tell whose usage drained it. */}
				{canVehicle && record && (
					<div className="min-w-0">
						<p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
							Also Assigned
						</p>
						{coDrivers.length === 0 ? (
							<p className="text-sm text-text-muted">No one else</p>
						) : (
							<ul className="flex flex-wrap gap-1.5">
								{coDrivers.map((t) => (
									<li key={t.id}>
										<Link
											to={`/dispatch/technicians/${t.id}?tab=vehicle`}
											className="inline-flex max-w-48 items-center gap-1.5 rounded-md border border-border-subtle py-0.5 pl-0.5 pr-2 text-xs font-medium text-text-secondary transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-raised hover:text-text-primary"
										>
											<span
												aria-hidden
												className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-avatar-bg text-[10px] font-semibold text-avatar-fg"
											>
												{initials(t.name)}
											</span>
											<span className="truncate">
												{t.name}
											</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{canOpen && (
					<Link to={vehicleHref} className={NAV_BUTTON}>
						Open Vehicle <ArrowUpRight size={14} aria-hidden />
					</Link>
				)}
			</div>
			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
				<div className="space-y-4 lg:col-span-2">
					<Card
						title="Low Stock"
						headerAction={
							canOpen && (
								<Link
									to={`${vehicleHref}?tab=stock`}
									className={NAV_BUTTON_SM}
								>
									<Package
										size={12}
										aria-hidden
									/>{" "}
									View Stock
								</Link>
							)
						}
					>
						{!canVehicle ? (
							<PermissionLine>
								Needs the View Vehicles permission.
							</PermissionLine>
						) : stock.isLoading ? (
							<div className="h-24 animate-pulse rounded bg-surface" />
						) : stock.isError ? (
							<p className="text-sm text-error-text">
								Couldn't load vehicle stock.
							</p>
						) : low.length === 0 ? (
							<p className="text-sm text-text-muted">
								Everything is at or above minimum.
							</p>
						) : (
							<ul className="divide-y divide-border-subtle">
								{low.map((s) => (
									<li
										key={s.id}
										className="flex items-center justify-between gap-3 py-2 text-sm"
									>
										<span
											data-testid="low-stock-name"
											className="min-w-0 truncate"
										>
											{
												s
													.inventory_item
													.name
											}
										</span>
										<span className="shrink-0 tabular-nums text-warning-text">
											{
												s.qty_on_hand
											}
											<span className="text-text-muted">
												{" "}
												/
												min{" "}
												{
													s.qty_min
												}
											</span>
										</span>
									</li>
								))}
							</ul>
						)}
						{canVehicle &&
							!stock.isLoading &&
							!stock.isError &&
							allLow.length > low.length && (
								<p className="mt-2 text-xs tabular-nums text-text-muted">
									Showing {low.length} of{" "}
									{allLow.length}
								</p>
							)}
					</Card>
					<Card
						title="Maintenance Due"
						headerAction={
							canOpen && (
								<Link
									to={`${vehicleHref}?tab=maintenance`}
									className={NAV_BUTTON_SM}
								>
									<Wrench
										size={12}
										aria-hidden
									/>{" "}
									View Maintenance
								</Link>
							)
						}
					>
						{!canVehicle ? (
							<PermissionLine>
								Needs the View Vehicles permission.
							</PermissionLine>
						) : reminders.isLoading ? (
							<div className="h-16 animate-pulse rounded bg-surface" />
						) : reminders.isError ? (
							<p className="text-sm text-error-text">
								Couldn't load maintenance reminders.
							</p>
						) : due.length === 0 ? (
							<p className="text-sm text-text-muted">
								Nothing due.
							</p>
						) : (
							<ul className="divide-y divide-border-subtle">
								{due.map(({ r, d }) => {
									const s = d.status as
										| "overdue"
										| "duesoon";
									return (
										<li
											key={r.id}
											className="flex items-center justify-between gap-3 py-2 text-sm"
										>
											<span className="min-w-0 truncate">
												{
													r.title
												}
											</span>
											<span
												className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_CLASSNAME[s]}`}
											>
												{
													STATUS_LABEL[
														s
													]
												}
												{d
													.dueLines[0]
													? ` · ${d.dueLines[0]}`
													: ""}
											</span>
										</li>
									);
								})}
							</ul>
						)}
					</Card>
				</div>
				<Card title="Readiness Today">
					{!canReadiness ? (
						<PermissionLine>
							Needs the View Inventory permission.
						</PermissionLine>
					) : readiness.isLoading ? (
						<div className="h-16 animate-pulse rounded bg-surface" />
					) : readiness.isError || !readiness.data ? (
						<p className="text-sm text-error-text">
							Couldn't load readiness.
						</p>
					) : (
						<div className="space-y-2 text-sm">
							<p
								className={
									readiness.data.state ===
									"needs_action"
										? "text-warning-text"
										: "text-text-primary"
								}
							>
								{
									READINESS_COPY[
										readiness.data.state
									]
								}
							</p>
							{readiness.data.gaps.length > 0 && (
								<ul className="space-y-1">
									{readiness.data.gaps.map(
										(g) => (
											<li
												key={
													g.inventory_item_id
												}
												className="flex justify-between gap-2"
											>
												<span className="min-w-0 truncate">
													{
														g.name
													}
												</span>
												<span className="shrink-0 tabular-nums text-text-tertiary">
													{
														g.qty_on_hand
													}{" "}
													of{" "}
													{
														g.qty_needed
													}
												</span>
											</li>
										)
									)}
								</ul>
							)}
						</div>
					)}
				</Card>
			</div>
		</Panel>
	);
}
