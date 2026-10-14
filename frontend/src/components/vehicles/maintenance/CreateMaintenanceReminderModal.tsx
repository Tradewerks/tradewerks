import { FormWizardContainer } from "../../ui/forms/FormWizardContainer";
import { useMemo, useState } from "react";
import { useToast } from "../../ui/useToast";
import { useCreateMaintenanceReminderMutation, useVehicleOdometer } from "../../../hooks/useVehicles";
import {
    MAINTENANCE_CATEGORY_LABELS,
    CreateMaintenanceReminderSchema,
    type MaintenanceCategory,
    type IntervalUnit,
    type CreateMaintenanceReminderInput,
} from "../../../types/vehicles";
import { CATEGORY_TILES, TINT_CLASSES } from "./categoryTiles";

const INPUT = "border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const INTERVAL_UNIT_LABELS: Record<IntervalUnit, string> = {
    days: "Days",
    weeks: "Weeks",
    months: "Months",
    years: "Years",
};

interface reminderProps {
    vehicleId: string;
    onSuccess?: () => void;
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function CreateMaintenanceReminderModal({
    vehicleId,
    onSuccess,
    isModalOpen,
    setIsModalOpen
}: reminderProps) {
    const [category, setCategory] = useState<MaintenanceCategory | null>(null);
    const [title, setTitle] = useState<string>("");
    const [description, setDescription] = useState<string>("");
    const [repeating, setRepeating] = useState<boolean>(true);
    const [intervalMiles, setIntervalMiles] = useState<string>("");
    const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("months");
    const [intervalCount, setIntervalCount] = useState<string>("");
    const [dueAt, setDueAt] = useState<string>("");
    const [dueOdometerMi, setDueOdometerMi] = useState<string>("");

    const toast = useToast();
    const { mutateAsync: createMaintenanceReminder } = useCreateMaintenanceReminderMutation();
    const [isLoading, setIsLoading] = useState(false);

    const currentOdometerMi = useVehicleOdometer(vehicleId);

    const resetForm = () => {
        setCategory(null);
        setTitle("");
        setDescription("");
        setRepeating(true);
        setIntervalMiles("");
        setIntervalUnit("months");
        setIntervalCount("");
        setDueAt("");
        setDueOdometerMi("");
    };

    const invokeCreate = async () => {
        if (isLoading) return;
        if (!category) {
            toast.error("Pick a category before saving.");
            return;
        }
        if (!title.trim()) {
            toast.error("Give the reminder a title.");
            return;
        }
        if (repeating && !intervalMiles && !intervalCount) {
            toast.error("Set an interval in miles, or a time interval.");
            return;
        }
        if (!repeating && !dueAt && !dueOdometerMi) {
            toast.error("Set a due date or mileage.");
            return;
        }

        const input: CreateMaintenanceReminderInput = {
            category,
            title: title.trim(),
            description: description.trim() || undefined,
            repeats: repeating,
            interval_miles: repeating && intervalMiles ? Number(intervalMiles) : undefined,
            interval_unit: repeating && intervalCount ? intervalUnit : undefined,
            interval_count: repeating && intervalCount ? Number(intervalCount) : undefined,
            due_at: !repeating && dueAt ? dueAt : undefined,
            due_odometer_mi: !repeating && dueOdometerMi ? Number(dueOdometerMi) : undefined,
        };

        const result = CreateMaintenanceReminderSchema.safeParse(input);
        if (!result.success) {
            toast.error(result.error.issues[0]?.message ?? "Check the form for errors.");
            return;
        }

        setIsLoading(true);
        try {
            await createMaintenanceReminder({ vehicleId, data: result.data });
            toast.success("Reminder added.");
            setIsModalOpen(false);
            resetForm();
            onSuccess?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to create reminder.");
        } finally {
            setIsLoading(false);
        }
    };

    const formContent = useMemo(() => (
        <div className="space-y-4">
            <label className={LABEL}>Category</label>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
                {CATEGORY_TILES.map((t) => {
                    const Icon = t.icon;
                    const isSelected = category === t.value;
                    const tint = TINT_CLASSES[t.tint];
                    return (
                        <button
                            key={t.value}
                            type="button"
                            onClick={() => setCategory(t.value)}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center transition-colors ${
                                isSelected ? tint.selected : "border-border-subtle bg-base text-text-muted hover:border-border-strong"
                            }`}
                        >
                            <div className={`flex h-6 w-6 items-center justify-center rounded-md ${tint.icon}`}>
                                <Icon size={13} />
                            </div>
                            <span className="text-[9.5px] font-semibold leading-tight">
                                {MAINTENANCE_CATEGORY_LABELS[t.value]}
                            </span>
                        </button>
                    )
                })}
            </div>

            <div>
                <label className={LABEL}>Title</label>
                <input
                    className={INPUT}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                />
            </div>

            <div>
                <label className={LABEL}>Description (optional)</label>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    maxLength={1000}
                    className={`${INPUT} h-auto py-2 resize-none`}
                />
            </div>

            <div className="rounded-lg border border-border-subtle bg-base p-3 space-y-2">
                <label className={LABEL}>Schedule</label>
                <div className="grid grid-cols-2 gap-1.5">
                    <button
                        type="button"
                        onClick={() => setRepeating(true)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            repeating ? "border-primary bg-primary/10 text-primary" : "border-border-subtle bg-base text-text-muted hover:border-border-strong"
                        }`}
                    >
                        Repeating
                    </button>
                    <button
                        type="button"
                        onClick={() => setRepeating(false)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            !repeating ? "border-primary bg-primary/10 text-primary" : "border-border-subtle bg-base text-text-muted hover:border-border-strong"
                        }`}
                    >
                        One time
                    </button>
                </div>

                {repeating
                    ? (
                        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                            <div>
                                <label className={LABEL}>Every (mi)</label>
                                <input
                                    className={`${INPUT} text-right tabular-nums`}
                                    inputMode="numeric"
                                    value={intervalMiles}
                                    onChange={(e) => setIntervalMiles(e.target.value.replace(/[^0-9]/g, ""))}
                                    placeholder="mi"
                                />
                            </div>
                            <span className="pb-2 text-xs font-medium text-text-muted">and/or</span>
                            <div>
                                <label className={LABEL}>Every</label>
                                <div className="flex gap-1.5">
                                    <div className="w-16 flex-none">
                                        <input
                                            className={`${INPUT} text-right tabular-nums`}
                                            inputMode="numeric"
                                            value={intervalCount}
                                            onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))}
                                            placeholder="3"
                                        />
                                    </div>
                                    <select
                                        className={`${INPUT} flex-1 min-w-0`}
                                        value={intervalUnit}
                                        onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                                    >
                                        {(Object.keys(INTERVAL_UNIT_LABELS) as IntervalUnit[]).map((unit) => (
                                            <option key={unit} value={unit}>{INTERVAL_UNIT_LABELS[unit]}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>
                    )
                    : (
                        <div className="space-y-1.5">
                            <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                                <div>
                                    <label className={LABEL}>Due date</label>
                                    <input
                                        type="date"
                                        className={INPUT}
                                        value={dueAt}
                                        onChange={(e) => setDueAt(e.target.value)}
                                    />
                                </div>
                                <span className="pb-2 text-xs font-medium text-text-muted">and/or</span>
                                <div>
                                    <div className="flex items-baseline justify-between gap-1">
                                        <label className={LABEL}>Due at (mi)</label>
                                        {currentOdometerMi != null && (
                                            <span className="text-[10px] normal-case tracking-normal font-normal text-text-muted whitespace-nowrap">
                                                currently at {currentOdometerMi.toLocaleString()} mi
                                            </span>
                                        )}
                                    </div>
                                    <input
                                        className={`${INPUT} text-right tabular-nums`}
                                        inputMode="numeric"
                                        value={dueOdometerMi}
                                        onChange={(e) => setDueOdometerMi(e.target.value.replace(/[^0-9]/g, ""))}
                                        placeholder="mi"
                                    />
                                </div>
                            </div>
                            {dueOdometerMi !== "" && Number(dueOdometerMi) < (currentOdometerMi ?? 0) && (
                                <p className="text-xs font-medium text-warning-text text-right">Set due milage is less than the current milage</p>
                            )}
                        </div>
                    )
                }
            </div>
        </div>
    ), [category, title, description, repeating, intervalMiles, intervalUnit, intervalCount, dueAt, dueOdometerMi, currentOdometerMi]);

    return (
        <FormWizardContainer
            title="New maintenance reminder"
            steps={[]}
            currentStep={1}
            visitedSteps={new Set([1])}
            isLoading={isLoading}
            isOpen={isModalOpen}
            onClose={() => {
                setIsModalOpen(false);
                resetForm();
            }}
            onSubmit={invokeCreate}
            submitLabel="Create reminder"
        >
            {formContent}
        </FormWizardContainer>
    )
}
