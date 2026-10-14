import { createPurchaseSchema, DESCRIPTION_MAX, type CreatePurchaseInput } from "../../api/purchases";
import type { ReconcileTarget } from "../../api/inventory";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { useEffect, useMemo, useState } from "react";
import SupplierFormModal from "../suppliers/SupplierFormModal";
import CreateInventoryItem from "../inventory/CreateInventoryItem";
import FilterableSelect, { type FilterableOption } from "../ui/forms/FilterableSelect";
import { useAllJobsQuery, useJobVisitsByJobIdQuery } from "../../hooks/useJobs";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import { useTaxGroups, useDefaultTaxGroup } from "../../hooks/useTaxGroups";
import { useSuppliers } from "../../hooks/useSuppliers";
import { normalizeSupplierName } from "../../lib/suppliers";
import { useCatalogSearchQuery } from "../../hooks/useInventory";
import type { ZodError } from "zod";
import { type PurchaseLineDisposition } from "../../types/purchases";
import type { SupplierCapture } from "../../types/suppliers";
import { formatCurrency, formatDateTime } from "../../util/util";
import { Plus, Trash2, X } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";

const INPUT =
    "border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-60";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";

/** Synthetic option id for "+ Create supplier …", prepended to the supplier field's list. */
const CREATE_SUPPLIER_OPTION_ID = "__create_supplier__";
/** Synthetic option id for "+ Create item …", prepended to a line's item field. */
const CREATE_ITEM_OPTION_ID = "__create_item__";

/** Form-local line shape — qty/price stay strings while typed, converted at submit. */
interface PurchaseLineDraft {
    key: string;
    description: string;
    quantity: string;
    unit_price: string;
    inventory_item_id: string | null;
    catalogItem: ReconcileTarget | null;
    disposition: PurchaseLineDisposition | null;
    disposition_vehicle_id: string | null;
    job_id: string | null;
    job_visit_id: string | null;
}

const blankLine = (defaultVehicleId?: string): PurchaseLineDraft => ({
    key: crypto.randomUUID(),
    description: "",
    quantity: "",
    unit_price: "",
    inventory_item_id: null,
    catalogItem: null,
    disposition: defaultVehicleId ? "receive" : null,
    disposition_vehicle_id: defaultVehicleId ?? null,
    job_id: null,
    job_visit_id: null,
});

interface JobOption {
    id: string;
    label: string;
}

interface PurchaseLineRowProps {
    draft: PurchaseLineDraft;
    jobs: JobOption[];
    vehicles: { id: string; name: string }[];
    onChange: (patch: Partial<PurchaseLineDraft>) => void;
    onRemove: () => void;
    onRequestCreateItem: (name: string) => void;
}

function PurchaseLineRow({ draft, jobs, vehicles, onChange, onRemove, onRequestCreateItem }: PurchaseLineRowProps) {
    const { data: visits } = useJobVisitsByJobIdQuery(draft.job_id ?? "");
    const lineTotal = (Number(draft.quantity) || 0) * (Number(draft.unit_price) || 0);
    // Server-searched, like CatalogItemPicker — the catalog is too large to filter client-side.
    const [debouncedDescription, setDebouncedDescription] = useState(draft.description);
    useEffect(() => {
        const t = setTimeout(() => setDebouncedDescription(draft.description.trim()), 200);
        return () => clearTimeout(t);
    }, [draft.description]);
    const { data: catalogResults } = useCatalogSearchQuery({ q: debouncedDescription || undefined });

    const CREATE = usePermission("manage_inventory");

    const catalogExactMatch = useMemo(() => {
        const q = debouncedDescription.trim().toLowerCase();
        if (!q) return undefined;
        return catalogResults?.find((t) => t.name.trim().toLowerCase() === q);
    }, [catalogResults, debouncedDescription]);
    // "+ Create item …" mirrors the supplier field's create option
    const catalogOptions = useMemo<FilterableOption[]>(() => {
        const base = (catalogResults ?? []).map((t) => ({ id: t.id, label: t.name, sublabel: t.sku ?? undefined }));
        if (draft.description.trim() && !catalogExactMatch && CREATE) {
            return [{ id: CREATE_ITEM_OPTION_ID, label: `+ Create item "${draft.description.trim()}"` }, ...base];
        }
        return base;
    }, [catalogResults, draft.description, catalogExactMatch]);
    const [jobQuery, setJobQuery] = useState("");
    const selectedJob = jobs.find((j) => j.id === draft.job_id);

    const [priceFocused, setPriceFocused] = useState(false);

    return (
        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                    <FilterableSelect
                        placeholder="Item"
                        ariaLabel="Item"
                        maxLength={DESCRIPTION_MAX}
                        value={draft.description}
                        onChange={(text) => onChange({ description: text })}
                        options={catalogOptions}
                        preFiltered
                        onSelect={(opt) => {
                            if (opt.id === CREATE_ITEM_OPTION_ID) {
                                onRequestCreateItem(draft.description.trim());
                                return;
                            }
                            const item = catalogResults?.find((t) => t.id === opt.id) ?? null;
                            draft.unit_price = String(item?.cost);
                            onChange({
                                description: opt.label,
                                inventory_item_id: item?.id ?? null,
                                catalogItem: item,
                            });
                        }}
                    />
                    {draft.catalogItem && (
                        <div className="flex items-center justify-between gap-2 rounded border border-primary-border bg-primary-bg px-2 py-1 text-xs">
                            <span className="truncate text-text-primary">
                                Linked to catalog{draft.catalogItem.sku ? ` · ${draft.catalogItem.sku}` : ""}
                            </span>
                            <button
                                type="button"
                                aria-label="Unlink catalog item"
                                onClick={() => onChange({ inventory_item_id: null, catalogItem: null })}
                                className="shrink-0 text-text-muted hover:text-error-text"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    aria-label="Remove line"
                    onClick={onRemove}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-error-text"
                >
                    <Trash2 size={14} />
                </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
                <div>
                    <label className={LABEL}>Qty</label>
                    <input
                        className={`${INPUT} text-right tabular-nums`}
                        inputMode="decimal"
                        value={draft.quantity}
                        onChange={(e) => onChange({ quantity: e.target.value.replace(/[^0-9.]/g, "") })}
                    />
                </div>
                <div>
                    <label className={LABEL}>Unit price</label>
                    <input
                        className={`${INPUT} text-right tabular-nums`}
                        inputMode="decimal"
                        value={priceFocused ? draft.unit_price : formatCurrency(Number(draft.unit_price) || 0)}
                        onChange={(e) => onChange({ unit_price: e.target.value.replace(/[^0-9.]/g, "") })}
                        onFocus={() => setPriceFocused(true)}
                        onBlur={() => setPriceFocused(false)}
                    />
                </div>
                <div>
                    <label className={LABEL}>Line total</label>
                    <p className="flex h-[34px] items-center justify-end px-2.5 text-sm tabular-nums text-text-secondary">
                        {formatCurrency(lineTotal)}
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className={LABEL}>Disposition</label>
                    <select
                        className={INPUT}
                        value={draft.disposition ?? ""}
                        onChange={(e) => {
                            const disposition = (e.target.value || null) as PurchaseLineDisposition | null;
                            onChange({
                                disposition,
                                disposition_vehicle_id: disposition === "receive" ? draft.disposition_vehicle_id : null,
                                job_id: disposition === "non_stock" ? draft.job_id : null,
                                job_visit_id: disposition === "non_stock" ? draft.job_visit_id : null,
                            });
                        }}
                    >
                        <option value="">Not set</option>
                        <option value="non_stock">Job-costed</option>
                        <option value="receive">Receive into stock</option>
                    </select>
                </div>

                {draft.disposition === "receive" && (
                    <div>
                        <label className={LABEL}>Destination</label>
                        <select
                            className={INPUT}
                            value={draft.disposition_vehicle_id ?? ""}
                            onChange={(e) => onChange({ disposition_vehicle_id: e.target.value || null })}
                        >
                            <option value="">Warehouse</option>
                            {vehicles.map((v) => (
                                <option key={v.id} value={v.id}>
                                    {v.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {draft.disposition === "non_stock" && (
                    <div>
                        <FilterableSelect
                            label="Job"
                            placeholder="Search jobs…"
                            value={selectedJob ? selectedJob.label : jobQuery}
                            options={jobs}
                            onChange={(text) => {
                                setJobQuery(text);
                                if (draft.job_id) onChange({ job_id: null, job_visit_id: null });
                            }}
                            onSelect={(opt) => {
                                setJobQuery("");
                                onChange({ job_id: opt.id, job_visit_id: null });
                            }}
                        />
                    </div>
                )}
            </div>

            {draft.disposition === "non_stock" && draft.job_id && (visits?.length ?? 0) > 0 && (
                <div>
                    <label className={LABEL}>Visit (optional)</label>
                    <select
                        className={INPUT}
                        value={draft.job_visit_id ?? ""}
                        onChange={(e) => onChange({ job_visit_id: e.target.value || null })}
                    >
                        <option value="">No specific visit</option>
                        {visits!.map((v) => (
                            <option key={v.id} value={v.id}>
                                {v.name ?? formatDateTime(v.scheduled_start_at)}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    );
}

interface CreatePurchaseProps {
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    createPurchaseOrder: (input: CreatePurchaseInput) => Promise<string>;
    /** Pre-selects "Receive into stock" → this vehicle on every line, e.g. when opened from a vehicle's maintenance record. */
    defaultDispositionVehicleId?: string;
}

export default function CreatePurchaseModal ({ isModalOpen, setIsModalOpen, createPurchaseOrder, defaultDispositionVehicleId }: CreatePurchaseProps) {
    const [vendorName, setVendorName] = useState("");
    const [supplier, setSupplier] = useState<SupplierCapture>({});
    const [supplierQuery, setSupplierQuery] = useState("");
    const [purchasedAt, setPurchasedAt] = useState("");
    // undefined = not yet seeded from the org default; null = "No tax", explicitly chosen.
    const [taxGroupId, setTaxGroupId] = useState<string | null | undefined>(undefined);
    const [lines, setLines] = useState<PurchaseLineDraft[]>(() => [blankLine(defaultDispositionVehicleId)]);
    const [errors, setErrors] = useState<ZodError | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
    const [supplierCreateSeed, setSupplierCreateSeed] = useState("");
    const [creatingItemForLineKey, setCreatingItemForLineKey] = useState<string | null>(null);
    const [itemCreateSeed, setItemCreateSeed] = useState("");

    const [isLoading, setIsLoading] = useState(false);

    const { data: jobsData } = useAllJobsQuery();
    const jobOptions = useMemo<JobOption[]>(
        () => (jobsData ?? []).map((j) => ({ id: j.id, label: `#${j.job_number} — ${j.name}` })),
        [jobsData],
    );
    const { data: vehiclesData } = useVehiclesQuery();
    const vehicles = useMemo(() => vehiclesData ?? [], [vehiclesData]);

    // items and suppilers both use manage_inventory
    const CREATE = usePermission("manage_inventory");

    // Suggests known supplier names on the free-text vendor field too — separate
    // from supplier_id below, which is what actually links the record.
    const { data: suppliersData } = useSuppliers();
    const vendorExactMatch = useMemo(() => {
        const key = normalizeSupplierName(vendorName);
        if (!key) return undefined;
        return suppliersData?.find((s) => normalizeSupplierName(s.name) === key);
    }, [suppliersData, vendorName]);
    const vendorOptions = useMemo<FilterableOption[]>(() => {
        const base = (suppliersData ?? []).map((s) => ({ id: s.id, label: s.name, sublabel: s.account_number ?? undefined }));
        if (vendorName.trim() && !vendorExactMatch && CREATE) {
            return [{ id: CREATE_SUPPLIER_OPTION_ID, label: `+ Create supplier "${vendorName.trim()}"` }, ...base];
        }
        return base;
    }, [suppliersData, vendorName, vendorExactMatch]);
    const handleVendorSelect = (opt: FilterableOption) => {
        if (opt.id === CREATE_SUPPLIER_OPTION_ID) {
            setSupplierCreateSeed(vendorName.trim());
            setIsSupplierModalOpen(true);
            return;
        }
        setVendorName(opt.label);
        setSupplierQuery(opt.label);
        setSupplier({ supplier_id: opt.id });
    };

    const supplierExactMatch = useMemo(() => {
        const key = normalizeSupplierName(supplierQuery);
        if (!key) return undefined;
        return suppliersData?.find((s) => normalizeSupplierName(s.name) === key);
    }, [suppliersData, supplierQuery]);
    // "+ Create supplier …" is prepended whenever the typed name has no exact match —
    // picking it opens SupplierFormModal pre-filled, rather than silently claiming
    // (like SupplierPicker does elsewhere) that a name alone will create one on save.
    const supplierOptions = useMemo<FilterableOption[]>(() => {
        const q = supplierQuery.trim().toLowerCase();
        const base = (suppliersData ?? [])
            .filter((s) => !q || s.name.toLowerCase().includes(q))
            .map((s) => ({ id: s.id, label: s.name, sublabel: s.account_number ?? undefined }));
        if (supplierQuery.trim() && !supplierExactMatch && CREATE) {
            return [{ id: CREATE_SUPPLIER_OPTION_ID, label: `+ Create supplier "${supplierQuery.trim()}"` }, ...base];
        }
        return base;
    }, [suppliersData, supplierQuery, supplierExactMatch]);

    const handleSupplierQueryChange = (text: string) => {
        setSupplierQuery(text);
        const key = normalizeSupplierName(text);
        const exact = key ? suppliersData?.find((s) => normalizeSupplierName(s.name) === key) : undefined;
        setSupplier(exact ? { supplier_id: exact.id } : {});
    };

    const handleSupplierSelect = (opt: FilterableOption) => {
        if (opt.id === CREATE_SUPPLIER_OPTION_ID) {
            setSupplierCreateSeed(supplierQuery.trim());
            setIsSupplierModalOpen(true);
            return;
        }
        setSupplierQuery(opt.label);
        setSupplier({ supplier_id: opt.id });
    };

    const supplierDisplayValue = supplier.supplier_id
        ? (suppliersData?.find((s) => s.id === supplier.supplier_id)?.name ?? supplierQuery)
        : supplierQuery;

    const { data: taxGroups = [] } = useTaxGroups();
    const { data: defaultTaxGroup } = useDefaultTaxGroup();
    useEffect(() => {
        if (taxGroupId === undefined && defaultTaxGroup !== undefined) {
            setTaxGroupId(defaultTaxGroup?.id ?? null);
        }
    }, [defaultTaxGroup, taxGroupId]);
    const taxGroup = taxGroups.find((g) => g.id === taxGroupId) ?? null;

    const subtotal = useMemo(
        () => lines.reduce((n, l) => n + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0),
        [lines],
    );
    // Rounded to cents
    const taxAmount = Math.round(subtotal * (taxGroup?.combined_rate ?? 0) * 100) / 100;

    const resetForm = () => {
        setVendorName("");
        setSupplier({});
        setSupplierQuery("");
        setPurchasedAt("");
        setTaxGroupId(undefined);
        setLines([blankLine(defaultDispositionVehicleId)]);
        setSupplierCreateSeed("");
        setCreatingItemForLineKey(null);
        setItemCreateSeed("");
        setSaveError(null);
    }

    const addLine = () => setLines((prev) => [...prev, blankLine(defaultDispositionVehicleId)]);
    const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));
    const updateLine = (key: string, patch: Partial<PurchaseLineDraft>) =>
        setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    const requestCreateItemForLine = (key: string, name: string) => {
        setCreatingItemForLineKey(key);
        setItemCreateSeed(name);
    };

    const invokeCreate = async () => {
        if (isLoading) return;

        // Typed-but-unmatched vs. never-typed both collapse to supplier_id "" —
        // only supplierQuery still distinguishes them.
        if (!supplier.supplier_id && supplierQuery.trim()) {
            setErrors(null);
            setSaveError("Invalid supplier — select one from the list, or use \"+ Create supplier\".");
            return;
        }

        // One allocation per job a line names — a job_visit_id is per-job, not
        // per-line, so the first line that picked one for a job wins.
        const jobIds = [...new Set(lines.map((l) => l.job_id).filter((id): id is string => id != null))];
        const allocations = jobIds.map((job_id) => ({
            job_id,
            job_visit_id: lines.find((l) => l.job_id === job_id && l.job_visit_id)?.job_visit_id ?? null,
        }));

        const newPurchaseOrder: CreatePurchaseInput = {
            vendor_name: vendorName,
            supplier_id: supplier.supplier_id ?? "",
            purchased_at: purchasedAt || undefined,
            tax_group_id: taxGroupId ?? null,
            tax_amount: taxAmount,
            allocations,
            lines: lines.map((l) => ({
                description: l.description,
                quantity: Number(l.quantity),
                unit_price: Number(l.unit_price),
                inventory_item_id: l.inventory_item_id,
                disposition: l.disposition,
                disposition_vehicle_id: l.disposition_vehicle_id,
                job_id: l.job_id,
            })),
        };

        const parseResult = createPurchaseSchema.safeParse(newPurchaseOrder);
        if (!parseResult.success) {
            setErrors(parseResult.error);
            return;
        }

        setErrors(null);
        setSaveError(null);
        setIsLoading(true);
        try {
            await createPurchaseOrder(newPurchaseOrder);
            setIsModalOpen(false);
            resetForm();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "Failed to create purchase order");
        } finally {
            setIsLoading(false);
        }
    };

    const isFormValid =
        vendorName.trim().length > 0 &&
        !!supplier.supplier_id &&
        lines.length > 0 &&
        lines.every(
            (l) =>
                l.description.trim().length > 0 &&
                Number(l.quantity) > 0 &&
                l.unit_price.trim() !== "" &&
                !Number.isNaN(Number(l.unit_price)),
        );

    const formContent = useMemo(() => (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                <FilterableSelect
                    label="Vendor name"
                    placeholder="Vendor name"
                    value={vendorName}
                    onChange={setVendorName}
                    options={vendorOptions}
                    onSelect={handleVendorSelect}
                />
                <FilterableSelect
                    label="Supplier"
                    placeholder="Supplier"
                    value={supplierDisplayValue}
                    onChange={handleSupplierQueryChange}
                    options={supplierOptions}
                    onSelect={handleSupplierSelect}
                    preFiltered
                />
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className={LABEL}>Purchased (optional)</label>
                    <input
                        type="date"
                        className={INPUT}
                        value={purchasedAt}
                        onChange={(e) => setPurchasedAt(e.target.value)}
                    />
                </div>
                <div>
                    <label className={LABEL}>Tax</label>
                    <select
                        className={INPUT}
                        value={taxGroupId ?? ""}
                        onChange={(e) => setTaxGroupId(e.target.value || null)}
                    >
                        <option value="">No tax</option>
                        {taxGroups.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.name} ({(g.combined_rate * 100).toFixed(2)}%)
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div>
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-text-primary">Lines</span>
                    <button
                        type="button"
                        onClick={addLine}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface"
                    >
                        <Plus size={13} /> Add line
                    </button>
                </div>
                <div className="space-y-2">
                    {lines.map((l) => (
                        <PurchaseLineRow
                            key={l.key}
                            draft={l}
                            jobs={jobOptions}
                            vehicles={vehicles}
                            onChange={(patch) => updateLine(l.key, patch)}
                            onRemove={() => removeLine(l.key)}
                            onRequestCreateItem={(name) => requestCreateItemForLine(l.key, name)}
                        />
                    ))}
                    {lines.length === 0 && (
                        <p className="text-sm text-text-muted">No lines yet — add at least one.</p>
                    )}
                </div>
            </div>

            <div className="flex justify-end">
                <div className="w-64 space-y-1 text-sm">
                    <div className="flex justify-between">
                        <span className="text-text-muted">Subtotal</span>
                        <span className="tabular-nums text-text-secondary">{formatCurrency(subtotal)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-text-muted">
                            Tax{taxGroup ? ` (${taxGroup.name})` : ""}
                        </span>
                        <span className="tabular-nums text-text-secondary">{formatCurrency(taxAmount)}</span>
                    </div>
                    <div className="flex justify-between border-t border-border-subtle pt-1 font-semibold text-text-primary">
                        <span>Total</span>
                        <span className="tabular-nums">{formatCurrency(subtotal + taxAmount)}</span>
                    </div>
                </div>
            </div>

            {(errors || saveError) && (
                <p className="text-sm text-error-text">{errors?.issues[0]?.message ?? saveError}</p>
            )}
        </div>
    ), [
        vendorName,
        vendorOptions,
        supplierDisplayValue,
        supplierOptions,
        handleSupplierQueryChange,
        purchasedAt,
        lines,
        jobOptions,
        vehicles,
        taxGroups,
        taxGroupId,
        taxGroup,
        taxAmount,
        subtotal,
        errors,
        saveError,
    ]);

    return (
        <>
            <FormWizardContainer
                title="Create Purchase Order"
				steps={[]}
				currentStep={1}
				visitedSteps={new Set([1])}
				isLoading={isLoading}
				isOpen={isModalOpen && !isSupplierModalOpen && creatingItemForLineKey === null}
				onClose={() => {
					setIsModalOpen(false);
					resetForm();
				}}
				onSubmit={invokeCreate}
				canGoNext={isFormValid}
				submitLabel="Create Purchase Order"
            >
                {formContent}
            </FormWizardContainer>
            <SupplierFormModal
                isOpen={isSupplierModalOpen}
                onClose={() => setIsSupplierModalOpen(false)}
                editing={null}
                initialName={supplierCreateSeed}
                onSaved={(saved) => {
                    setVendorName(saved.name);
                    setSupplierQuery(saved.name);
                    setSupplier({ supplier_id: saved.id });
                    setIsSupplierModalOpen(false);
                }}
            />
            <CreateInventoryItem
                isOpen={creatingItemForLineKey !== null}
                onClose={() => setCreatingItemForLineKey(null)}
                initialName={itemCreateSeed}
                onCreated={(item) => {
                    if (creatingItemForLineKey) {
                        updateLine(creatingItemForLineKey, {
                            description: item.name,
                            inventory_item_id: item.id,
                            unit_price: String(item.cost ?? ""),
                            catalogItem: {
                                id: item.id,
                                name: item.name,
                                sku: item.sku,
                                unit: item.unit,
                                cost: item.cost,
                                provisional: false,
                            },
                        });
                    }
                    setCreatingItemForLineKey(null);
                }}
            />
        </>
    );
}
