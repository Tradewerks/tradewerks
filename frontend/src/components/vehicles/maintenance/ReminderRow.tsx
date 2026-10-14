import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDeleteMaintenanceReminderMutation, useAcknowledgeMaintenanceReminderMutation, useUnacknowledgeMaintenanceReminderMutation, useCompleteMaintenanceReminderMutation } from "../../../hooks/useVehicles";
import { MAINTENANCE_CATEGORY_LABELS, type VehicleMaintenanceReminder } from "../../../types/vehicles";
import { STATUS_LABEL, STATUS_CLASSNAME, scheduleText, type ReminderDue } from "../../../util/vehicleMaintenanceStatus";
import { usePermission } from "../../../hooks/usePermission";
import { useToast } from "../../ui/useToast";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { CATEGORY_ICON } from "./categoryIcon";

export default function ReminderRow({
    vehicleId,
    reminder,
    due,
    openEdit,
    onLogService,
}: {
    vehicleId: string;
    reminder: VehicleMaintenanceReminder;
    due: ReminderDue;
    openEdit: () => void;
    onLogService: () => void;
}) {
    const { icon: Icon, className: chipClassName } = CATEGORY_ICON[reminder.category];
    const canEdit = usePermission("manage_vehicles");
    const { mutateAsync: deleteReminder, isPending: isDeleting } = useDeleteMaintenanceReminderMutation();
    const { mutateAsync: acknowledgeReminder, isPending: isAcknowledging } = useAcknowledgeMaintenanceReminderMutation();
    const { mutateAsync: unacknowledgeReminder, isPending: isUnacknowledging } = useUnacknowledgeMaintenanceReminderMutation();
    const { mutateAsync: completeReminder, isPending: isCompleting } = useCompleteMaintenanceReminderMutation();
    const toast = useToast();
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const isAcknowledged = reminder.acknowledged_at != null;
    const canAcknowledge = due.status === "overdue" || due.status === "duesoon";

    const handleDelete = async () => {
        try {
            await deleteReminder({ vehicleId, reminderId: reminder.id });
            toast.success("Reminder deleted.");
            setConfirmingDelete(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to delete reminder.");
        }
    };

    const handleAcknowledge = async () => {
        try {
            await acknowledgeReminder({ vehicleId, reminderId: reminder.id });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to acknowledge reminder.");
        }
    };

    const handleUnacknowledge = async () => {
        try {
            await unacknowledgeReminder({ vehicleId, reminderId: reminder.id });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to undo acknowledgement.");
        }
    };

    const handleComplete = async () => {
        try {
            await completeReminder({ vehicleId, reminderId: reminder.id });
            toast.success("Reminder marked done.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to mark reminder done.");
        }
    };

    return (
        <>
        <div className={`flex flex-col gap-1.5 px-3 py-3 ${isAcknowledged ? "bg-surface" : ""}`}>
            <div className="flex items-center gap-2">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${chipClassName}`}>
                    <Icon size={13} />
                </div>
                <p className="flex-1 min-w-0 text-sm font-semibold text-text-primary truncate">{reminder.title}</p>
                <button
                    className="hover:cursor-pointer hover:bg-surface-raised border border-border-subtle p-1.5 rounded-md shrink-0"
                    disabled={!canEdit}
                    title={!canEdit ? "You don't have permission to perform this action" : undefined}
                    onClick={openEdit}
                >
                    <Pencil size={12} />
                </button>
                <button
                    className="hover:cursor-pointer hover:bg-error/10 hover:text-error-text border border-border-subtle p-1.5 rounded-md shrink-0 disabled:opacity-60"
                    disabled={!canEdit || isDeleting}
                    title={!canEdit ? "You don't have permission to perform this action" : undefined}
                    onClick={() => setConfirmingDelete(true)}
                >
                    <Trash2 size={12} />
                </button>
            </div>
            <p className="pl-9 text-xs text-text-muted truncate">
                {MAINTENANCE_CATEGORY_LABELS[reminder.category]} · {scheduleText(reminder)}
            </p>
            <div className="flex flex-col gap-1 pl-9">
                <div className="flex items-center justify-between gap-2">
                    {due.status !== "none" ? (
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_CLASSNAME[due.status]}`}>
                            {STATUS_LABEL[due.status]}
                        </span>
                    ) : <span />}
                    <span className="text-xs text-text-secondary text-right truncate">{due.dueLines[0]}</span>
                </div>
                {due.dueLines[1] && (
                    <span className="text-xs text-text-secondary text-right truncate">{due.dueLines[1]}</span>
                )}
            </div>
            {isAcknowledged ? (
                <div className="flex items-center justify-between gap-2 pl-9">
                    <span className="text-xs italic text-text-faint">
                        {reminder.repeats ? "Acknowledged — muted until next visit" : "Acknowledged"}
                    </span>
                    <div className="flex items-center gap-3 shrink-0">
                        <button
                            className="text-xs font-semibold text-primary-text hover:underline hover:cursor-pointer"
                            onClick={onLogService}
                        >
                            Log service
                        </button>
                        {!reminder.repeats && (
                            <button
                                className="text-xs font-semibold text-primary-text hover:underline disabled:opacity-60 hover:cursor-pointer"
                                disabled={isCompleting}
                                onClick={handleComplete}
                            >
                                Mark done
                            </button>
                        )}
                        <button
                            className="text-xs font-semibold text-primary-text hover:underline disabled:opacity-60 hover:cursor-pointer"
                            disabled={isUnacknowledging}
                            onClick={handleUnacknowledge}
                        >
                            Undo
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex gap-1.5 pl-9">
                    <button
                        className="flex-1 rounded-md bg-primary hover:bg-primary-hover px-2.5 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:cursor-pointer"
                        onClick={onLogService}
                    >
                        Log service
                    </button>
                    {canAcknowledge && (
                        <button
                            className="rounded-md border border-border-subtle px-2.5 py-1.5 text-xs font-semibold text-text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 hover:cursor-pointer"
                            disabled={isAcknowledging}
                            onClick={handleAcknowledge}
                        >
                            Acknowledge
                        </button>
                    )}
                </div>
            )}
        </div>
        <ConfirmDialog
            open={confirmingDelete}
            title="Delete reminder?"
            body={
                <>
                    <span className="font-medium text-text-primary">{reminder.title}</span> will be permanently
                    removed. This cannot be undone.
                </>
            }
            confirmLabel="Delete"
            tone="destructive"
            pending={isDeleting}
            onConfirm={handleDelete}
            onCancel={() => setConfirmingDelete(false)}
        />
        </>
    );
}
