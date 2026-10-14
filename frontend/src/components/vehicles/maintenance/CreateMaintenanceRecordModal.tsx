import { useEffect, useMemo, useState } from "react";
import { FormWizardContainer } from "../../ui/forms/FormWizardContainer";
import { CATEGORY_TILES, TINT_CLASSES } from "./categoryTiles";
import FilterableSelect, { type FilterableOption } from "../../ui/forms/FilterableSelect";
import { useCreateMaintenanceRecordMutation, useMaintenanceSourceLinesQuery, useVehicleMaintenanceQuery, useVehicleMaintenanceReminderQuery, useVehicleOdometer } from "../../../hooks/useVehicles";
import { dueFor, STATUS_LABEL, STATUS_CLASSNAME, STATUS_RANK, type ReminderStatus } from "../../../util/vehicleMaintenanceStatus";
import {
  CreateMaintenanceRecordSchema,
  MAINTENANCE_CATEGORY_LABELS,
  type MaintenanceCategory,
  type CreateMaintenanceRecordInput,
} from "../../../types/vehicles";
import { formatCurrency } from "../../../util/util";
import { useToast } from "../../ui/useToast";
import { useSuppliers } from "../../../hooks/useSuppliers";
import { normalizeSupplierName } from "../../../lib/suppliers";
import type { SupplierCapture } from "../../../types/suppliers";
import SupplierFormModal from "../../suppliers/SupplierFormModal";
import CreatePurchaseModal from "../../purchases/CreatePurchaseModal";
import { useCreatePurchaseMutation } from "../../../hooks/usePurchases";
import { usePermission } from "../../../hooks/usePermission";
 
const INPUT = "border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const CREATE_SUPPLIER_OPTION_ID = "__create_supplier__";
const CREATE_PURCHASE_OPTION_ID = "__create_purchase__";

// 300ms debounce so search doesn't fire per keystroke.
function useDebouncedValue<T>(value: T, delayMs = 300): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [value, delayMs]);
    return debounced;
}

interface CreateMaintenanceRecordProps {
    vehicleId: string;
    onSuccess?: () => void;
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    defaultCategory?: MaintenanceCategory | null;
    preselectedReminderId?: string | null;
}
export default function CreateMaintenanceRecordModal ({
  vehicleId,
  onSuccess,
  isModalOpen,
  setIsModalOpen,
  defaultCategory = null,
  preselectedReminderId = null,
}: CreateMaintenanceRecordProps) {
    const [category, setCategory] = useState<MaintenanceCategory | null>(defaultCategory);
    const [datePerformed, setDatePerformed] = useState<string>(() => new Date().toISOString().slice(0, 10));
    const [odometer, setOdometer] = useState("");
    const [vendor, setVendor] = useState<string>("");
    const [cost, setCost] = useState("");
    const [costFocused, setCostFocused] = useState(false);
    const [maintenanceNotes, setMaintenanceNotes] = useState<string>("");
    const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
    const [supplierCreateSeed, setSupplierCreateSeed] = useState("");
    const [, setSupplier] = useState<SupplierCapture>({});
    const [, setSupplierQuery] = useState("");
    const [purchaseAttached, setPurchaseAttached] = useState<string>("");
    const [purchaseQuery, setPurchaseQuery] = useState<string>("");
    const [isCreatePurchaseModalOpen, setIsCreatePurchaseModalOpen] = useState(false);
    const [coveredReminderIds, setCoveredReminderIds] = useState<Set<string>>(
        () => new Set(preselectedReminderId ? [preselectedReminderId] : [])
    );

    const CREATE_VENDOR = usePermission("manage_inventory");
    const CREATE_PURCHASE = usePermission("manage_purchases");

    const { data: reminders } = useVehicleMaintenanceReminderQuery(vehicleId);
    const { data: records } = useVehicleMaintenanceQuery(vehicleId);
    const currentOdometerMi = useVehicleOdometer(vehicleId);
    const statusOf = (reminder: NonNullable<typeof reminders>[number]) => dueFor(reminder, currentOdometerMi).status;
    const categoryReminders = (reminders ?? [])
        .filter((r) => r.category === category && (r.repeats || r.completed_at == null))
        .sort((a, b) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]);
    const toggleCovered = (id: string) => {
        setCoveredReminderIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const { mutateAsync: createPurchaseOrder } = useCreatePurchaseMutation();
    const { mutateAsync: createMaintenanceRecord } = useCreateMaintenanceRecordMutation();
    const toast = useToast();

    const [isLoading, setIsLoading] = useState(false);

    const debouncedPurchaseQuery = useDebouncedValue(purchaseQuery);
    const { data: purchaseData } = useMaintenanceSourceLinesQuery(vehicleId, debouncedPurchaseQuery);
    const purchaseOptions = useMemo<FilterableOption[]>(() => {
            const base = (purchaseData ?? []).map((p) => ({
                id: p.id,
                label: `${p.reference ? `#${p.reference} - ` : ""}${p.description} (${p.vendor_name ?? "Unknown vendor"})`,
                sublabel: formatCurrency(p.cost),
            }));
            if (purchaseQuery.trim() && CREATE_PURCHASE) {
                return [{ id: CREATE_PURCHASE_OPTION_ID, label: `+ Create purchase "${purchaseQuery.trim()}"` }, ...base];
            }
            return base;
        },
    [purchaseData, purchaseQuery]);
    const handlePurchaseSelect = (opt: FilterableOption) => {
        if (opt.id === CREATE_PURCHASE_OPTION_ID) {
            setIsCreatePurchaseModalOpen(true);
            return;
        }
        setPurchaseAttached(opt.id);
        setPurchaseQuery(opt.label);
        const matched = purchaseData?.find((p) => p.id === opt.id);
        if (matched) setCost(String(matched.cost));
    };
    const { data: suppliersData } = useSuppliers();
    const vendorExactMatch = useMemo(() => {
        const key = normalizeSupplierName(vendor);
        if (!key) return undefined;
        return suppliersData?.find((s) => normalizeSupplierName(s.name) === key);
    }, [suppliersData, vendor]);
    const vendorOptions = useMemo<FilterableOption[]>(() => {
        const base = (suppliersData ?? []).map((s) => ({ id: s.id, label: s.name, sublabel: s.account_number ?? undefined }));
        if (vendor.trim() && !vendorExactMatch && CREATE_VENDOR) {
            return [{ id: CREATE_SUPPLIER_OPTION_ID, label: `+ Create supplier "${vendor.trim()}"` }, ...base];
        }
        return base;
    }, [suppliersData, vendor, vendorExactMatch]);
    const handleVendorSelect = (opt: FilterableOption) => {
        if (opt.id === CREATE_SUPPLIER_OPTION_ID) {
            setSupplierCreateSeed(vendor.trim());
            setIsSupplierModalOpen(true);
            return;
        }
        setVendor(opt.label);
        setSupplierQuery(opt.label);
        setSupplier({ supplier_id: opt.id });
    };

    const resetForm = () => {
        setCategory(null);
        setDatePerformed(new Date().toISOString().slice(0, 10));
        setOdometer("");
        setVendor("");
        setCost("");
        setCostFocused(false);
        setMaintenanceNotes("");
        setSupplier({});
        setSupplierQuery("");
        setSupplierCreateSeed("");
        setPurchaseAttached("");
        setPurchaseQuery("");
        setCoveredReminderIds(new Set());
    }

    const invokeCreate = async () => {
        if (isLoading) return;
        if (!category) {
            toast.error("Pick a category before saving.");
            return;
        }

        const matchedPurchase = purchaseData?.find((p) => p.id === purchaseAttached);
        const input: CreateMaintenanceRecordInput = {
            category,
            performed_at: datePerformed,
            odometer_mi: odometer ? Number(odometer) : undefined,
            cost: cost ? Number(cost) : undefined,
            vendor_name: vendor.trim() || undefined,
            notes: maintenanceNotes.trim() || undefined,
            source_purchase_line_id: matchedPurchase?.source === "purchase" ? matchedPurchase.id : undefined,
            source_field_purchase_line_id: matchedPurchase?.source === "field_purchase" ? matchedPurchase.id : undefined,
            reminder_ids: categoryReminders.filter((r) => coveredReminderIds.has(r.id)).map((r) => r.id),
        };

        const result = CreateMaintenanceRecordSchema.safeParse(input);
        if (!result.success) {
            toast.error(result.error.issues[0]?.message ?? "Check the form for errors.");
            return;
        }

        setIsLoading(true);
        try {
            await createMaintenanceRecord({ vehicleId, data: result.data });
            toast.success("Maintenance record added.");
            setIsModalOpen(false);
            resetForm();
            onSuccess?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to create maintenance record.");
        } finally {
            setIsLoading(false);
        }
    };

    const formContent = useMemo(() => (
        <div className="space-y-4" >
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
            {categoryReminders.length > 0 && (
                <>
                    <label className={LABEL}>Reminders</label>
                    <div className="rounded-lg border border-border-subtle bg-base divide-y divide-border-subtle max-h-64 overflow-y-auto">
                        {categoryReminders.map((r) => (
                            <label key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary hover:cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={coveredReminderIds.has(r.id)}
                                    onChange={() => toggleCovered(r.id)}
                                />
                                <span className="flex-1 min-w-0 truncate">{r.title}</span>
                                <span className="hidden sm:inline text-xs text-text-muted shrink-0">{r.repeats ? "resets interval" : "mark done"}</span>
                                <StatusBadge status={statusOf(r)} />
                            </label>
                        ))}
                    </div>
                </>
            )}
            <label className={LABEL} >Service Details</label>
            <div className="rounded-lg border border-border-subtle bg-base p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className={LABEL}>Date performed</label>
                        <input
                            type="date"
                            className={INPUT}
                            value={datePerformed}
                            onChange={(e) => setDatePerformed(e.target.value)}
                        />
                    </div>
                    <div>
                        <label className={LABEL}>Odometer (optional)</label>
                        <input
                            className={`${INPUT} text-right tabular-nums`}
                            inputMode="numeric"
                            placeholder="mi"
                            value={odometer}
                            onChange={(e) => setOdometer(e.target.value.replace(/[^0-9]/g, ""))}
                        />
                        {currentOdometerMi != null && (
                            <p className="mt-0.5 text-right text-[10px] text-text-muted">
                                currently at {currentOdometerMi.toLocaleString()} mi
                            </p>
                        )}
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <FilterableSelect
                            label="Vendor (optional)"
                            placeholder="Vendor"
                            value={vendor}
                            onChange={setVendor}
                            options={vendorOptions}
                            onSelect={handleVendorSelect}
                        />
                    </div>
                    <div>
                        <label className={LABEL}>Cost (optional)</label>
                        <input
                            className={`${INPUT} text-right tabular-nums`}
                            inputMode="decimal"
                            value={costFocused ? cost : formatCurrency(Number(cost) || 0)}
                            onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ""))}
                            onFocus={() => setCostFocused(true)}
                            onBlur={() => setCostFocused(false)}
                        />
                    </div>
                </div>
            </div>
            <label className={LABEL} >Notes (optional)</label>
            <textarea
                value={maintenanceNotes}
                onChange={(e) => setMaintenanceNotes(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="Full synthetic 5W-30, filter replaced…"
                className={`${INPUT} h-auto py-2 resize-none`}
            />
            <FilterableSelect
                label="Link a purchase (optional)"
                placeholder="Search purchases by description, PO/receipt #, or vendor…"
                value={purchaseQuery}
                onChange={(text) => {
                    setPurchaseQuery(text);
                    setPurchaseAttached("");
                }}
                options={purchaseOptions}
                onSelect={handlePurchaseSelect}
                preFiltered
            />
            {purchaseOptions.length === 0 && !purchaseAttached && (
                <p className="text-sm text-text-muted">No purchases on file for this vehicle to link.</p>
            )}
        </div>
    ), [category, datePerformed, odometer, vendor, vendorOptions, cost, costFocused, maintenanceNotes, purchaseOptions, purchaseQuery, reminders, records, coveredReminderIds]);
    return (
        <>
            <FormWizardContainer
                title="New maintenance record"
                steps={[]} 
                currentStep={1}
                visitedSteps={new Set([1])}
                isLoading={isLoading}
                isOpen={isModalOpen && !isSupplierModalOpen && !isCreatePurchaseModalOpen}
                onClose={() => {
                    setIsModalOpen(false);
                    resetForm();
                }}
                onSubmit={invokeCreate}
                submitLabel="Create maintenance record"
            >
                {formContent}
            </ FormWizardContainer>

            <SupplierFormModal
                isOpen={isSupplierModalOpen}
                onClose={() => setIsSupplierModalOpen(false)}
                editing={null}
                initialName={supplierCreateSeed}
                onSaved={(saved) => {
                    setVendor(saved.name);
                    setSupplierQuery(saved.name);
                    setSupplier({ supplier_id: saved.id });
                    setIsSupplierModalOpen(false);
                }}
            />

            <CreatePurchaseModal
                isModalOpen={isCreatePurchaseModalOpen}
                setIsModalOpen={setIsCreatePurchaseModalOpen}
                defaultDispositionVehicleId={vehicleId}
                createPurchaseOrder={async (input) => {
                    const newPurchase = await createPurchaseOrder(input);
                    if (!newPurchase?.id) throw new Error("Purchase creation failed: no ID returned");
                    setIsCreatePurchaseModalOpen(false);
                    // Re-run the search so purchaseData has this PO's line(s) by submit time.
                    setPurchaseQuery(newPurchase.purchase_number);
                    if (newPurchase.lines.length === 1) {
                        // Only line this flow seeds — attach it directly.
                        const line = newPurchase.lines[0];
                        setPurchaseAttached(line.id);
                        setCost(String(Number(line.line_total)));
                    } else {
                        // Ambiguous — let the user pick from the dropdown.
                        setPurchaseAttached("");
                    }
                    return newPurchase.id;
                }}
            />
        </>
    )
}

function StatusBadge({ status }: { status: ReminderStatus }) {
    if (status === "none") return null;
    return (
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_CLASSNAME[status]}`}>
            {STATUS_LABEL[status]}
        </span>
    );
}
