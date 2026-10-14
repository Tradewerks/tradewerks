import { useQBPurchaseOrderQuery } from "../../hooks/useQuickbooks";
import { formatCurrency, formatDateOnly } from "../../util/util";

export default function QBPurchaseOrdersCard() {
    const { data: purchaseOrders, isLoading } = useQBPurchaseOrderQuery();

    return (
        <div>
            <p className="mb-4 text-xs text-text-muted leading-relaxed max-w-2xl">
                Purchase orders synced from QuickBooks Online, read-only.
            </p>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[520px]">
                    <thead>
                        <tr className="border-b border-border-subtle">
                            <th className="px-5 py-2.5 text-left text-xs font-medium text-text-muted">Doc #</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Vendor</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Date</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Status</th>
                            <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading ? (
                            <tr>
                                <td colSpan={5} className="px-5 py-8 text-center text-sm text-text-muted">
                                    Loading…
                                </td>
                            </tr>
                        ) : purchaseOrders?.length ? (
                            purchaseOrders.map((po, idx) => (
                                <tr
                                    key={po.Id}
                                    className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${idx === purchaseOrders.length - 1 ? "border-b-0" : ""}`}
                                >
                                    <td className="px-5 py-3 text-sm font-medium text-text-primary">{po.DocNumber ?? `#${po.Id}`}</td>
                                    <td className="px-3 py-3 text-sm text-text-secondary">{po.VendorRef.name ?? "—"}</td>
                                    <td className="px-3 py-3 text-xs text-text-muted">{formatDateOnly(po.TxnDate)}</td>
                                    <td className="px-3 py-3">
                                        <span
                                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${
                                                po.POStatus === "Closed"
                                                    ? "bg-surface-raised text-text-muted border-border"
                                                    : "bg-success-bg text-success-text border-success-border"
                                            }`}
                                        >
                                            {po.POStatus ?? "Open"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-3 text-right text-sm font-medium text-text-primary">
                                        {formatCurrency(po.TotalAmt)}
                                    </td>
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={5} className="px-5 py-8 text-center text-sm text-text-muted">
                                    No purchase orders yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
