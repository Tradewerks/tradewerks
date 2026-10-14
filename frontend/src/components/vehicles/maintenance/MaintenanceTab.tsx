import { Plus, type LucideIcon, ChevronDown, Pencil, BellPlus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useVehicleMaintenanceQuery, useVehicleMaintenanceReminderQuery, useVehicleOdometer } from "../../../hooks/useVehicles";
import { MAINTENANCE_CATEGORY_LABELS, type MaintenanceCategory, type VehicleMaintenanceRecord, type VehicleMaintenanceReminder } from "../../../types/vehicles";
import { formatDateOnly, daysUntil } from "../../../util/util";
import { latestOf, dueFor, scheduleText, STATUS_RANK } from "../../../util/vehicleMaintenanceStatus";
import { useAnyPermission, usePermission } from "../../../hooks/usePermission";
import CreateMaintenanceRecordModal from "./CreateMaintenanceRecordModal";
import UpdateMaintenanceRecordModal from "./UpdateMaintenanceRecordModal";
import CreateMaintenanceReminderModal from "./CreateMaintenanceReminderModal";
import UpdateMaintenanceReminderModal from "./UpdateMaintenanceReminderModal";
import ReminderRow from "./ReminderRow";
import Card from "../../ui/Card";
import { CATEGORY_ICON } from "./categoryIcon";

interface maintenanceTabProps {
    vehicleId: string;
}

const CATEGORIES: { label: string; icon: LucideIcon; iconClassName: string; matches: MaintenanceCategory[] }[] = [
    { label: "Oil change", icon: CATEGORY_ICON.oil_change.icon, iconClassName: CATEGORY_ICON.oil_change.className, matches: ["oil_change"] },
    { label: "Fluids", icon: CATEGORY_ICON.fluids.icon, iconClassName: CATEGORY_ICON.fluids.className, matches: ["fluids"] },
    { label: "Tires", icon: CATEGORY_ICON.tire.icon, iconClassName: "bg-primary-bg text-primary", matches: ["tire"] },
    { label: "Brakes", icon: CATEGORY_ICON.brake.icon, iconClassName: "bg-error/15 text-error-text", matches: ["brake"] },
    { label: "Inspection", icon: CATEGORY_ICON.inspection.icon, iconClassName: CATEGORY_ICON.inspection.className, matches: ["inspection"] },
    { label: "Registration", icon: CATEGORY_ICON.registration.icon, iconClassName: CATEGORY_ICON.registration.className, matches: ["registration"] },
];

function intervalFor(latest?: VehicleMaintenanceRecord): string {
    if (latest?.interval_miles == null && latest?.interval_months == null) return "—";
    return `${latest.interval_miles != null ? `${latest.interval_miles} mi` : "—"} / ${latest.interval_months != null ? `${latest.interval_months} mo` : "—"}`;
}

// Elapsed time since latest service — the "age"/"wear" stats look backward, unlike next-due.
function monthsSince(performedAt: string): number {
    return Math.max(0, Math.round(-daysUntil(performedAt) / 30));
}

function MaintenanceRecordRow({
    record,
    expanded,
    onToggle,
    openEdit,
}: {
    record: VehicleMaintenanceRecord;
    expanded: boolean;
    onToggle: () => void;
    openEdit: () => void;
}) {
    const loggedBy = record.performed_by?.name ?? record.performed_by_tech?.name;
    const linkedPurchasePath = record.source_purchase_id
        ? `/dispatch/purchases/${record.source_purchase_id}`
        : record.source_field_purchase_id
            ? `/dispatch/purchases?tab=field_purchases&purchase=${record.source_field_purchase_id}`
            : null;
    const hasReminder = record.interval_miles != null || record.interval_months != null;
    const { icon: Icon, className: chipClassName } = CATEGORY_ICON[record.category];

    const canEdit = usePermission("manage_vehicles");

    const metaParts = [formatDateOnly(record.performed_at)];
    if (record.odometer_mi != null) metaParts.push(`${record.odometer_mi.toLocaleString()} mi`);
    if (record.vendor_name) metaParts.push(record.vendor_name);

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                onClick={onToggle}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggle();
                    }
                }}
                className="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-surface-raised/40 transition-colors cursor-pointer"
            >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${chipClassName}`}>
                    <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary">
                        {MAINTENANCE_CATEGORY_LABELS[record.category]}
                    </p>
                    <p className="text-xs text-text-muted truncate">{metaParts.join(" · ")}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-sm font-semibold tabular-nums ${record.cost != null ? "text-text-primary" : "text-text-faint font-medium"}`}>
                        {record.cost != null ? `$${record.cost.toFixed(2)}` : "—"}
                    </span>
                    <button
                        className="hover:cursor-pointer hover:bg-surface-raised border border-border-subtle p-2 rounded-md"
                        disabled={!canEdit}
                        title={!canEdit ? "You don't have permission to perform this action" : undefined}
                        onClick={(e) => {
                            e.stopPropagation();
                            openEdit();
                        }}
                    >
                        <Pencil size={14} />
                    </button>
                    <ChevronDown
                        size={14}
                        className={`text-text-faint transition-transform duration-150 ${expanded ? "rotate-180" : ""} hover:cursor-pointer`}
                    />
                </div>
            </div>

            {expanded && (
                <div className="px-4 pb-4 pl-[66px] space-y-2.5">
                    {(loggedBy || hasReminder || linkedPurchasePath) && (
                        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                            {loggedBy && (
                                <div>
                                    <dt className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Logged by</dt>
                                    <dd className="text-xs text-text-secondary">{loggedBy}</dd>
                                </div>
                            )}
                            {hasReminder && (
                                <div>
                                    <dt className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Reminder</dt>
                                    <dd className="text-xs text-text-secondary tabular-nums">{intervalFor(record)}</dd>
                                </div>
                            )}
                            {linkedPurchasePath && (
                                <div>
                                    <dt className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Linked purchase</dt>
                                    <dd>
                                        <Link
                                            to={linkedPurchasePath}
                                            className="text-xs font-semibold text-primary-text hover:underline"
                                        >
                                            View purchase
                                        </Link>
                                    </dd>
                                </div>
                            )}
                        </dl>
                    )}
                    {record.notes && (
                        <>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Notes</label>
                            <p className="text-xs text-text-secondary leading-relaxed bg-surface-raised rounded-lg border border-border-subtle pl-3 py-2">
                                {record.notes}
                            </p>
                        </>
                        
                    )}
                </div>
            )}
        </div>
    );
}

export default function MaintenanceTab ({ vehicleId }: maintenanceTabProps) {
    const { data: records, isLoading, isError } = useVehicleMaintenanceQuery(vehicleId);
    const { data: reminders, isLoading: remindersLoading, isError: remindersError } = useVehicleMaintenanceReminderQuery(vehicleId);
    const canCreate = useAnyPermission(["manage_vehicles", "use_vehicles"]);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isCreateReminderModalOpen, setIsCreateReminderModalOpen] = useState(false);
    const [isEditReminderModalOpen, setIsEditReminderModalOpen] = useState(false);
    const [selectedRecord, setSelectedRecord] = useState<VehicleMaintenanceRecord | null>(null);
    const [selectedReminder, setSelectedReminder] = useState<VehicleMaintenanceReminder | null>(null);
    const [logServiceReminder, setLogServiceReminder] = useState<VehicleMaintenanceReminder | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [activeRecords, setActiveRecords] = useState<Set<MaintenanceCategory>>(
      () => new Set(Object.keys(MAINTENANCE_CATEGORY_LABELS) as MaintenanceCategory[])
    );

    const currentYear = new Date().getFullYear();
    const maintenanceCostYTD = records
        ?.filter((r) => new Date(r.performed_at).getFullYear() === currentYear)
        .reduce((sum, r) => sum + (r.cost ?? 0), 0);

    const latestTire = latestOf((records ?? []).filter((r) => r.category === "tire"));
    const latestBrake = latestOf((records ?? []).filter((r) => r.category === "brake"));
    const tireAge = latestTire ? `${monthsSince(latestTire.performed_at)} months` : "—";
    const brakeWear = latestBrake ? `${monthsSince(latestBrake.performed_at)} months` : "—";

    const currentOdometerMi = useVehicleOdometer(vehicleId);
    const sortedReminders = (reminders ?? [])
        .filter((reminder) => reminder.repeats || reminder.completed_at == null)
        .map((reminder) => ({ reminder, due: dueFor(reminder, currentOdometerMi) }))
        .sort((a, b) => STATUS_RANK[a.due.status] - STATUS_RANK[b.due.status] || a.due.urgency - b.due.urgency);
    const soonestReminderIn = (categories: MaintenanceCategory[]) =>
        sortedReminders.find(({ reminder, due }) => categories.includes(reminder.category) && due.status !== "none");
    const nextOilChange = soonestReminderIn(["oil_change"]);

    const entries = records?.filter(({ category }) => activeRecords.has(category));
    const toggleRecord = (key: MaintenanceCategory) => {
        setActiveRecords((prev) => {
            const newSet = new Set(prev);
            if (newSet.has(key)) newSet.delete(key);
            else newSet.add(key);
            return newSet;
        });
    };
    return (
        <div className="flex flex-col gap-4 p-4">
            {canCreate && (
                <div className="flex justify-end gap-2">
                    <button 
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary hover:bg-primary-hover px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors"
                        onClick={() => setIsCreateReminderModalOpen(true)}
                    >
                        <BellPlus size={14}/> Create Reminder
                    </button>
                    <button
                        type="button"
                        onClick={() => {setLogServiceReminder(null); setIsCreateModalOpen(true)}}
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary hover:bg-primary-hover px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors"
                    >
                        <Plus size={14} /> Add record
                    </button>
                </div>
            )}
            {/** overhead stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-base border border-border-subtle rounded-lg py-3 px-4 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Next oil change</p>
                    <p className="text-lg font-semibold text-text-primary truncate">{nextOilChange?.due.dueLines[0].replace(/^due /, "") ?? "—"}</p>
                    {nextOilChange && (
                        <p className="text-xs text-text-muted truncate">{nextOilChange.reminder.title}</p>
                    )}
                </div>
                <div className="bg-base border border-border-subtle rounded-lg py-3 px-4 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Tire age</p>
                    <p className="text-lg font-semibold text-text-primary">{tireAge}</p>
                </div>
                <div className="bg-base border border-border-subtle rounded-lg py-3 px-4 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Brake wear</p>
                    <p className="text-lg font-semibold text-text-primary">{brakeWear}</p>
                </div>
                <div className="bg-base border border-border-subtle rounded-lg py-3 px-4 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Maintenance cost YTD</p>
                    <p className="text-lg font-semibold text-text-primary">
                        {maintenanceCostYTD != null ? `$${maintenanceCostYTD.toFixed(2)}` : "—"}
                    </p>
                </div>
            </div>

            {/** summaries */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {CATEGORIES.map(({ label, icon: Icon, iconClassName, matches }) => {
                    const categoryRecords = (records ?? []).filter((r) => matches.includes(r.category));
                    const latest = latestOf(categoryRecords);

                    const soonest = soonestReminderIn(matches);

                    return (
                        <div key={label} className="bg-base border border-border-subtle rounded-xl p-3 flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconClassName}`}>
                                    <Icon size={16} />
                                </div>
                                <p className="text-sm font-semibold text-text-primary flex-1 min-w-0">{label}</p>
                            </div>
                            <div className="flex justify-between gap-2 text-xs border-t border-border-subtle pt-1.5">
                                <span className="text-text-muted">Last service</span>
                                <span className="font-medium text-text-primary text-right">
                                    {latest
                                        ? `${formatDateOnly(latest.performed_at)}${latest.odometer_mi != null ? ` @ ${latest.odometer_mi.toLocaleString()} mi` : ""}`
                                        : "—"}
                                </span>
                            </div>
                            <div className="flex justify-between gap-2 text-xs border-t border-border-subtle pt-1.5">
                                <span className="text-text-muted">Next due</span>
                                <span className="font-medium text-text-primary text-right">
                                    {soonest ? soonest.due.dueLines.map((line) => <span key={line} className="block">{line}</span>) : "—"}
                                </span>
                            </div>
                            <div className="flex justify-between gap-2 text-xs border-t border-border-subtle pt-1.5">
                                <span className="text-text-muted">Interval</span>
                                <span className="font-medium text-text-primary text-right">{soonest ? scheduleText(soonest.reminder) : "—"}</span>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="flex flex-col lg:flex-row gap-4 items-start">
                <div className="w-full lg:flex-1 lg:min-w-0 flex flex-col gap-4">
                    {/** history */}
                    <Card title="Maintenance Records">
                        {isLoading && (
                            <p className="text-sm text-text-muted">Loading maintenance history…</p>
                        )}
                        {isError && (
                            <p className="text-sm text-error-text">Failed to load maintenance history.</p>
                        )}
                        {!isLoading && !isError && records?.length === 0 && (
                            <p className="text-sm text-text-muted">No maintenance records yet.</p>
                        )}
                        {!isLoading && !isError && records && records.length > 0 && (
                            <div className="flex flex-col max-h-[560px] min-h-0">
                                <div className="flex flex-wrap items-center gap-1 mb-1 flex-none">
                                    {(Object.entries(MAINTENANCE_CATEGORY_LABELS) as [MaintenanceCategory, string][]).map(( [category, label] ) => {
                                        const {icon: Icon, className} = CATEGORY_ICON[category];
                                        const enabled = activeRecords.has(category);
                                        return (
                                            <button
                                                key={category}
                                                onClick={() => toggleRecord(category)}
                                                aria-pressed={enabled}
                                                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors hover:cursor-pointer
                                                    ${enabled ? className : "text-text-muted hover:text-text-secondary hover:bg-surface-raised"}`}
                                            >
                                                <Icon size={11} aria-hidden="true" />
                                                {label}
                                            </button>
                                        )
                                    })}
                                </div>

                                <div className="rounded-lg border border-border-subtle divide-y divide-border-subtle overflow-y-auto flex-1 min-h-0">
                                    {entries?.map((record) => (
                                        <MaintenanceRecordRow
                                            key={record.id}
                                            record={record}
                                            expanded={expandedId === record.id}
                                            onToggle={() => setExpandedId(expandedId === record.id ? null : record.id)}
                                            openEdit={() => {setSelectedRecord(record); setIsEditModalOpen(true)}}
                                        />
                                    ))}
                                </div>
                            </div>

                        )}
                    </Card>
                </div>

                {/** reminders */}
                <div className="w-full lg:w-[420px] flex-none">
                    <Card title="Reminders">
                        {remindersLoading && (
                            <p className="text-sm text-text-muted">Loading reminders…</p>
                        )}
                        {remindersError && (
                            <p className="text-sm text-error-text">Failed to load reminders.</p>
                        )}
                        {!remindersLoading && !remindersError && sortedReminders.length === 0 && (
                            <p className="text-sm text-text-muted">No reminders yet.</p>
                        )}
                        {!remindersLoading && !remindersError && sortedReminders.length > 0 && (
                            <div className="flex flex-col gap-2 overflow-y-auto max-h-[560px] pr-1">
                                {sortedReminders.map(({ reminder, due }) => (
                                    <div key={reminder.id} className="rounded-lg border border-border-subtle">
                                        <ReminderRow
                                            vehicleId={vehicleId}
                                            reminder={reminder}
                                            due={due}
                                            openEdit={() => {setSelectedReminder(reminder); setIsEditReminderModalOpen(true)}}
                                            onLogService={() => {setLogServiceReminder(reminder); setIsCreateModalOpen(true)}}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>
                </div>
            </div>

            {isCreateModalOpen && (
                <CreateMaintenanceRecordModal
                    vehicleId={vehicleId}
                    isModalOpen={isCreateModalOpen}
                    setIsModalOpen={setIsCreateModalOpen}
                    defaultCategory={logServiceReminder?.category ?? null}
                    preselectedReminderId={logServiceReminder?.id ?? null}
                    onSuccess={() => setLogServiceReminder(null)}
                />
            )}
            {isEditModalOpen && selectedRecord && (
                <UpdateMaintenanceRecordModal
                    vehicleId={vehicleId}
                    record={selectedRecord}
                    isModalOpen={isEditModalOpen}
                    setIsModalOpen={setIsEditModalOpen}
                />
            )}
            {isCreateReminderModalOpen && (
                <CreateMaintenanceReminderModal
                    vehicleId={vehicleId}
                    isModalOpen={isCreateReminderModalOpen}
                    setIsModalOpen={setIsCreateReminderModalOpen}
                />
            )}
            {isEditReminderModalOpen && selectedReminder && (
                <UpdateMaintenanceReminderModal
                    vehicleId={vehicleId}
                    reminder={selectedReminder}
                    isModalOpen={isEditReminderModalOpen}
                    setIsModalOpen={setIsEditReminderModalOpen}
                />
            )}
        </div>
    )
}