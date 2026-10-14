import { useEffect, useMemo, useState } from "react";
import { CATEGORY_TILES, TINT_CLASSES } from "./categoryTiles";
import { FormWizardContainer } from "../../ui/forms/FormWizardContainer";
import FilterableSelect, { type FilterableOption } from "../../ui/forms/FilterableSelect";
import { useUpdateMaintenanceRecordMutation, useMaintenanceSourceLinesQuery } from "../../../hooks/useVehicles";
import {
  UpdateMaintenanceRecordSchema,
  MAINTENANCE_CATEGORY_LABELS,
  type MaintenanceCategory,
  type UpdateMaintenanceRecordInput,
  type VehicleMaintenanceRecord,
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

interface UpdateMaintenanceRecordProps {
    vehicleId: string;
    record: VehicleMaintenanceRecord;
    onSuccess?: () => void;
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
export default function UpdateMaintenanceRecordModal ({
  vehicleId,
  record,
  onSuccess,
  isModalOpen,
  setIsModalOpen
}: UpdateMaintenanceRecordProps) {
    const [category, setCategory] = useState<MaintenanceCategory | null>(record.category);
    const [datePerformed, setDatePerformed] = useState<string>(record.performed_at.slice(0, 10));
    const [odometer, setOdometer] = useState(record.odometer_mi != null ? String(record.odometer_mi) : "");
    const [vendor, setVendor] = useState<string>(record.vendor_name ?? "");
    const [cost, setCost] = useState(record.cost != null ? String(record.cost) : "");
    const [costFocused, setCostFocused] = useState(false);
    const [maintenanceNotes, setMaintenanceNotes] = useState<string>(record.notes ?? "");
    const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
    const [supplierCreateSeed, setSupplierCreateSeed] = useState("");
    const [, setSupplier] = useState<SupplierCapture>({});
    const [, setSupplierQuery] = useState("");
    const [purchaseAttached, setPurchaseAttached] = useState<string>("");
    const [purchaseQuery, setPurchaseQuery] = useState<string>("");
    const [isCreatePurchaseModalOpen, setIsCreatePurchaseModalOpen] = useState(false);
    const { mutateAsync: createPurchaseOrder } = useCreatePurchaseMutation();
    const { mutateAsync: UpdateMaintenanceRecord } = useUpdateMaintenanceRecordMutation();
    const toast = useToast();

    const [isLoading, setIsLoading] = useState(false);

    const CREATE_VENDOR = usePermission("manage_inventory");
    const CREATE_PURCHASE = usePermission("manage_purchases");
    
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

    const linkedLineId = record.source_purchase_line_id ?? record.source_field_purchase_line_id;
    useEffect(() => {
        if (purchaseAttached || !linkedLineId) return;
        const matched = purchaseOptions.find((o) => o.id === linkedLineId);
        if (matched) {
            setPurchaseAttached(matched.id);
            setPurchaseQuery(matched.label);
        }
    }, [purchaseOptions, linkedLineId, purchaseAttached]);
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
    }

    const invokeUpdate = async () => {
        if (isLoading) return;
        if (!category) {
            toast.error("Pick a category before saving.");
            return;
        }

        // Empty field means "clear it": send `null`, not `undefined` (JSON drops that, keeping the old value).
        const matchedPurchase = purchaseData?.find((p) => p.id === purchaseAttached);
        const input: UpdateMaintenanceRecordInput = {
            category,
            performed_at: datePerformed,
            odometer_mi: odometer ? Number(odometer) : null,
            cost: cost ? Number(cost) : null,
            vendor_name: vendor.trim() || null,
            notes: maintenanceNotes.trim() || null,
            source_purchase_line_id: matchedPurchase?.source === "purchase" ? matchedPurchase.id : null,
            source_field_purchase_line_id: matchedPurchase?.source === "field_purchase" ? matchedPurchase.id : null,
        };

        const result = UpdateMaintenanceRecordSchema.safeParse(input);
        if (!result.success) {
            toast.error(result.error.issues[0]?.message ?? "Check the form for errors.");
            return;
        }

        setIsLoading(true);
        try {
            await UpdateMaintenanceRecord({ vehicleId, recordId: record.id, data: result.data });
            toast.success("Maintenance record updated.");
            setIsModalOpen(false);
            resetForm();
            onSuccess?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to update maintenance record.");
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
    ), [category, datePerformed, odometer, vendor, vendorOptions, cost, costFocused, maintenanceNotes, purchaseOptions, purchaseQuery]);
    return (
        <>
            <FormWizardContainer
                title="Edit maintenance record"
                steps={[]} 
                currentStep={1}
                visitedSteps={new Set([1])}
                isLoading={isLoading}
                isOpen={isModalOpen && !isSupplierModalOpen && !isCreatePurchaseModalOpen}
                onClose={() => {
                    setIsModalOpen(false);
                    resetForm();
                }}
                onSubmit={invokeUpdate}
                submitLabel="Update maintenance record"
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