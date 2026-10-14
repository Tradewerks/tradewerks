import { useNavigate, useParams } from "react-router-dom";
import PageHeader from "../../components/ui/PageHeader";
import { useGetPurchaseByIdQuery, useOrderPurchaseMutation, useCancelPurchaseMutation } from "../../hooks/usePurchases";
import { usePushPurchaseToQBMutation, useQBStatusQuery } from "../../hooks/useQuickbooks";
import { viewQBPurchaseOrderPdf } from "../../api/quickbooks";
import { useToast } from "../../components/ui/useToast";
import { PURCHASE_STATUS_LABELS, PURCHASE_STATUS_COLORS, isOpenPurchase } from "../../types/purchases";
import { MoreVertical, Package, PackageCheck, Ban, Plus, Check, Pencil, X, ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Card from "../../components/ui/Card";
import AdaptableTable from "../../components/AdaptableTable";
import { formatDate, formatDateTime , formatCurrency } from "../../util/util";
import { usePermission } from "../../hooks/usePermission";
import { downloadPurchaseOrderPdf } from "../../api/purchases";
import EditPurchaseModal from "../../components/purchases/EditPurchaseModal";
import ReceivePurchaseModal from "../../components/purchases/ReceivePurchaseModal";

const EVENT_LABELS: Record<string, string> = {
    "purchase.created": "Purchase created",
    "purchase.updated": "Purchase updated",
    "purchase.lines_replaced": "Lines replaced",
    "purchase.ordered": "Ordered",
    "purchase.cancelled": "Cancelled",
    "purchase.received": "Purchase received",
};

const EVENT_ICONS: Record<string, ReactNode> = {
    "purchase.created": <Plus size={11} />,
    "purchase.updated": <Pencil size={11} />,
    "purchase.lines_replaced": <ListChecks size={11} />,
    "purchase.ordered": <Check size={11} />,
    "purchase.cancelled": <X size={11} />,
    "purchase.received": <Package size={11} />,
};

/** Only "ordered" gets the primary-tinted dot — every other event reads as a neutral, informational step. */
const EVENT_DOT_CLASS: Record<string, string> = {
    "purchase.ordered": "border-primary/30 bg-primary/10 text-primary-text",
};
const EVENT_DOT_DEFAULT_CLASS = "border-border bg-surface text-text-secondary";

const LINE_HEADER_LABELS: Record<string, string> = {
    item: "Item",
    quantity: "Qty",
    unitPrice: "Unit",
    job: "Job",
    stockEffect: "Effect on Stock",
    total: "Total",
};

const LINE_COLUMN_ALIGN: Record<string, "left" | "right"> = {
    quantity: "right",
    unitPrice: "right",
    total: "right",
};

const LINE_CELL_CLASS: Record<string, (row: Record<string, unknown>) => string> = {
    stockEffect: () => "text-text-muted",
};

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className={`flex items-baseline justify-between gap-4 ${strong ? "mt-2 border-t border-border-subtle pt-2" : ""}`}>
            <dt className={strong ? "text-text-primary" : "text-text-muted"}>{label}</dt>
            <dd className={`tabular-nums ${strong ? "font-semibold text-text-primary" : "text-text-secondary"}`}>
                {formatCurrency(Number(value))}
            </dd>
        </div>
    );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div>
            <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
            <p className="text-sm font-medium text-text-primary">{value}</p>
        </div>
    );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
            <span className="text-text-muted">{label}</span>
            <span className="font-medium tabular-nums text-text-primary">{value}</span>
        </div>
    );
}


export default function PurchaseDetailsPage () {
    const { purchaseId } = useParams<{ purchaseId: string }>();
    const navigate = useNavigate();
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [isPdfLoading, setIsPdfLoading] = useState(false);
    const [isQBPdfLoading, setIsQBPdfLoading] = useState(false);
    const actionsMenuRef = useRef<HTMLDivElement>(null);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [receiveModalOpen, setReceiveModalOpen] = useState(false);

    useEffect(() => {
        if (!showActionsMenu) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!actionsMenuRef.current?.contains(e.target as Node)) setShowActionsMenu(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setShowActionsMenu(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [showActionsMenu]);

    const MANAGE_PURCHASES = usePermission("manage_purchases");

    const { mutate: orderPurchase, isPending: isOrdering } = useOrderPurchaseMutation();
    const { mutate: cancelPurchase, isPending: isCancelling } = useCancelPurchaseMutation();
    const toast = useToast();
    const { mutate: pushToQB, isPending: isPushing } = usePushPurchaseToQBMutation();
    const qbConnected = !!useQBStatusQuery().data?.connected;
    const { data } = useGetPurchaseByIdQuery(purchaseId ?? "", !!purchaseId);
    const purchase = data?.purchase;
    const events = data?.events;
    const lines = useMemo(() => {
        const allocations = purchase?.allocations ?? [];
        return (purchase?.lines ?? []).map((l) => {
            const allocation = l.allocation_id
                ? allocations.find((a) => a.id === l.allocation_id)
                : undefined;
            const job = allocation?.job
                ? (allocation.job.job_number ? `#${allocation.job.job_number}` : (allocation.job.name ?? "Job"))
                : "—";
            const stockEffect =
                l.disposition === "non_stock"
                    ? "Job-costed, not stocked"
                    : l.disposition === "receive"
                        ? l.disposition_vehicle
                            ? `${l.disposition_vehicle.name} — Added to stock`
                            : "General stock — Added to stock"
                        : "—";
            return {
                id: l.id,
                _itemId: l.inventory_item_id,
                item: l.description,
                quantity: l.quantity,
                unitPrice: formatCurrency(Number(l.unit_price)),
                job,
                stockEffect,
                total: formatCurrency(Number(l.line_total)),
            };
        });
    }, [purchase?.lines, purchase?.allocations]);
    const allocations = purchase?.allocations ?? [];

    const handleQBPush = () => {
        if (!purchaseId) {
            toast.error("No purchase found")
            return;
        }
        if (purchase && !purchase.supplier_id) {
            toast.error("Link a supplier before pushing to QuickBooks");
            return;
        }
        if (purchase && !purchase.vendor_name) {
            toast.error("Link a vendor before pushing to QuickBooks");
            return;
        }
        pushToQB(purchaseId, {
            onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to push to QuickBooks"),
        })
    }
                        

    const handleQBPdf = async () => {
        if (!purchaseId) return;
        setIsQBPdfLoading(true);
        try {
            await viewQBPurchaseOrderPdf(purchaseId);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to view QB purchase order PDF");
        } finally {
            setIsQBPdfLoading(false);
            setShowActionsMenu(false);
        }
    };

    const handlePdfDownload = async () => {
        if (!purchaseId || !purchase) return
        setIsPdfLoading(true);
        try {
            const docNumber = purchase.qb_purchase_id
                ? `QB-${purchase.qb_purchase_id}`
                : `PO-${purchaseId.slice(0, 8).toUpperCase()}`;
            await downloadPurchaseOrderPdf(purchaseId, docNumber);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to download purchase order PDF");
        } finally {
            setIsPdfLoading(false);
            setShowActionsMenu(false);
        }
    }

    return (
        <div>
            <PageHeader
                title={purchase?.vendor_name ?? purchase?.supplier?.name ?? "Purchase Details"}
                subtitle={purchase?.submitted_at ? `Submitted ${formatDate(purchase.submitted_at)}` : undefined}
            >
                {purchase && (
                    <span className={`px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${PURCHASE_STATUS_COLORS[purchase.status]}`}>
                        {PURCHASE_STATUS_LABELS[purchase.status]}
                    </span>
                )}
                {purchase?.status === "draft" && (
                    <button
                        className="flex items-center gap-1 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={!MANAGE_PURCHASES || !purchaseId || isOrdering}
                        onClick={() => purchaseId && orderPurchase(purchaseId)}
                    >
                       <Package size={16} /> {isOrdering ? "Ordering…" : "Order"}
                    </button>
                )}
                
                
                {qbConnected && purchase?.status !== "draft" && (
                    purchase?.qb_sync_status === "synced" ? (
                        <span className="flex items-center gap-1.5 px-2 py-1 rounded-full border text-sm font-medium text-success-text border-success-text/30 bg-success-text/10">
                            <Check size={14} /> Synced to QuickBooks
                        </span>
                    ) : (
                        <button
                            className="flex items-center gap-1 px-4 py-2 rounded-md text-sm font-medium bg-quickbooks hover:enabled:bg-quickbooks-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={!purchaseId || isPushing}
                            onClick={handleQBPush}
                        >
                            {isPushing ? "Pushing…" : "Push to QB"}
                        </button>
                    )
                )}
                <div className="relative" ref={actionsMenuRef}>
                    <button
                        className="p-2 hover:cursor-pointer hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
                        onClick={() => setShowActionsMenu((v) => !v)}
                    >
                        <MoreVertical size={20} />
                    </button>
                    {showActionsMenu && (
                        <div className="absolute right-0 top-full mt-2 w-56 bg-canvas border border-border-strong rounded-lg shadow-2xl shadow-black/50 z-50">
                            <div className="py-1">
                                {purchase?.status === "draft" && (
                                    <button
                                        disabled={!MANAGE_PURCHASES}
                                        onClick={() => setEditModalOpen(true)}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2 hover:cursor-pointer"
                                    >
                                        Edit Purchase Order
                                    </button>
                                )}
                                <button
                                    disabled={!purchaseId || isPdfLoading}
                                    onClick={handlePdfDownload}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2 hover:cursor-pointer"
                                >
                                    {isPdfLoading ? "Downloading…" : "Download as PDF"}
                                </button>
                                {(qbConnected && purchase?.qb_purchase_id) && (
                                    <button
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2 hover:cursor-pointer"
                                        disabled={!purchaseId || isQBPdfLoading}
                                        onClick={handleQBPdf}
                                    >
                                        {isQBPdfLoading ? "Loading…" : "Download QuickBooks PDF"}
                                    </button>
                                )}
                                {purchase &&
                                    (purchase.status === "ordered" || purchase.status === "partially_received") && (
                                        <button
                                            disabled={!MANAGE_PURCHASES}
                                            onClick={() => {
                                                setReceiveModalOpen(true);
                                                setShowActionsMenu(false);
                                            }}
                                            className="w-full px-4 py-2 text-left text-sm hover:bg-surface/70 transition-colors flex items-center gap-2 hover:cursor-pointer"
                                        >
                                            <PackageCheck size={16} />
                                            Receive
                                        </button>
                                    )}
                                {purchase && isOpenPurchase(purchase.status) && (
                                    <>
                                        <div className="my-1 border-t border-border-subtle" />
                                        <button
                                            className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                                                confirmCancel
                                                    ? "bg-error hover:bg-error-strong text-on-primary"
                                                    : "text-error-text hover:bg-surface hover:text-error-text"
                                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                                            disabled={!MANAGE_PURCHASES || !purchaseId || isCancelling}
                                            onMouseLeave={() => setConfirmCancel(false)}
                                            onClick={() => {
                                                if (!purchaseId) return;
                                                if (!confirmCancel) {
                                                    setConfirmCancel(true);
                                                    return;
                                                }
                                                cancelPurchase(
                                                    { id: purchaseId },
                                                    { onSuccess: () => setConfirmCancel(false) },
                                                );
                                            }}
                                        >
                                            <Ban size={16} />
                                            {isCancelling ? "Cancelling…" : confirmCancel ? "Click Again to Confirm" : "Cancel"}
                                        </button>
                                    </>
                                    
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </PageHeader>
            <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[2fr_1fr]">
                <div className="space-y-5">
                    <Card title="Purchase Details">
                        <div className="grid grid-cols-3 gap-3.5">
                            <Field label="Vendor" value={purchase?.vendor_name ?? "—"} />
                            <Field label="Supplier" value={purchase?.supplier?.name ?? "—"} />
                            <Field
                                label="Purchased"
                                value={purchase?.purchased_at ? formatDate(purchase.purchased_at) : "—"}
                            />
                        </div>
                    </Card>
                    <Card title="Lines" className="[&>div:last-child]:p-0">
                        <AdaptableTable
                            data={lines}
                            formatNums={false}
                            headerLabels={LINE_HEADER_LABELS}
                            columnAlign={LINE_COLUMN_ALIGN}
                            cellClass={LINE_CELL_CLASS}
                            cellRenderers={{
                                job: (row) =>
                                    row.job === "—" ? (
                                        <span className="text-text-muted">—</span>
                                    ) : (
                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md border bg-primary/10 border-primary/30 text-primary-text text-xs font-medium">
                                            {row.job as string}
                                        </span>
                                    ),
                            }}
                            onRowClick={(row) => row._itemId && navigate(`/dispatch/inventory/items/${row._itemId as string}`)}
                        />
                        {purchase && (
                            <dl className="space-y-1 border-t border-border-subtle px-4 py-3 text-sm">
                                <MoneyRow label="Subtotal" value={purchase.subtotal} />
                                <MoneyRow label="Tax" value={purchase.tax_amount} />
                                <MoneyRow label="Total" value={purchase.total} strong />
                            </dl>
                        )}
                    </Card>
                    <Card title="Job allocations" className="[&>div:last-child]:p-0">
                        {allocations.length > 0 ? (
                            <div className="divide-y divide-border-subtle">
                                {allocations.map((a) => (
                                    <div key={a.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                                        <div className="min-w-0">
                                            <p className="truncate font-medium text-text-primary">
                                                {a.job
                                                    ? a.job.job_number
                                                        ? `Job #${a.job.job_number}${a.job.name ? ` — ${a.job.name}` : ""}`
                                                        : (a.job.name ?? "Job")
                                                    : "—"}
                                            </p>
                                            {a.job_visit?.scheduled_start_at && (
                                                <p className="text-[11px] text-text-tertiary">
                                                    Visit: {formatDateTime(a.job_visit.scheduled_start_at)}
                                                </p>
                                            )}
                                        </div>
                                        <p className="shrink-0 font-medium tabular-nums text-text-primary">
                                            {formatCurrency(Number(a.amount))}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="px-4 py-3 text-sm text-text-muted">No job allocations</p>
                        )}
                    </Card>
                </div>
                <div className="space-y-5">
                    <Card title="Summary">
                        <div className="divide-y divide-border-subtle">
                            <SummaryRow
                                label="Status"
                                value={purchase ? PURCHASE_STATUS_LABELS[purchase.status] : "—"}
                            />
                            <SummaryRow label="Total" value={purchase ? formatCurrency(Number(purchase.total)) : "—"} />
                            <SummaryRow label="Lines" value={purchase?.lines.length ?? 0} />
                            <SummaryRow
                                label="Submitted"
                                value={purchase?.submitted_at ? formatDate(purchase.submitted_at) : "Not submitted"}
                            />
                        </div>
                    </Card>
                    <Card title="Trail">
                        <div className="space-y-3">
                            {(events && events.length > 0) ? events?.map((e) => (
                                <div key={e.id} className="flex items-start gap-2.5">
                                    <div
                                        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${EVENT_DOT_CLASS[e.type] ?? EVENT_DOT_DEFAULT_CLASS}`}
                                    >
                                        {EVENT_ICONS[e.type] ?? <Pencil size={11} />}
                                    </div>
                                    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                                        <div className="min-w-0">
                                            <span className="text-xs font-medium text-text-secondary">
                                                {EVENT_LABELS[e.type] ?? e.type}
                                            </span>
                                            <span className="ml-1.5 text-[11px] text-text-tertiary">
                                                {e.actor_type}
                                            </span>
                                        </div>
                                        <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                                            {formatDateTime(e.at)}
                                        </span>
                                    </div>
                                </div>
                            ))
                            : (
                                <div className="text-sm text-text-muted">
                                    No History
                                </div>
                            )
                            }
                        </div>
                    </Card>
                </div>
            </div>
            <EditPurchaseModal
                isModalOpen={editModalOpen}
                setIsModalOpen={setEditModalOpen}
                purchase={purchase ?? null}
            />
            {purchase && (
                <ReceivePurchaseModal
                    isOpen={receiveModalOpen}
                    onClose={() => setReceiveModalOpen(false)}
                    purchase={purchase}
                />
            )}
        </div>
    )
}