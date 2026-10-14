import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import { type Numeric, type OrgPdfProps, toNum, fmt, fmtDate } from "./pdfHelpers.js";

// ── PDF prop types — mirrors PURCHASE_SELECT/LINE_SELECT in purchasesController.ts ──

interface PurchaseOrderInventoryItem {
    name: string;
    sku?: string | null;
}

interface PurchaseOrderVehicle {
    name: string;
}

interface PurchaseOrderLine {
    id?: string;
    description: string;
    quantity: Numeric;
    unit_price: Numeric;
    line_total: Numeric;
    inventory_item?: PurchaseOrderInventoryItem | null;
    disposition?: "consume" | "receive" | "non_stock" | null;
    disposition_vehicle?: PurchaseOrderVehicle | null;
    allocation_id?: string | null;
}

interface PurchaseOrderJob {
    job_number?: number | string | null;
    name?: string | null;
}

interface PurchaseOrderJobVisit {
    name?: string | null;
}

interface PurchaseOrderAllocation {
    id: string;
    amount: Numeric;
    job?: PurchaseOrderJob | null;
    job_visit?: PurchaseOrderJobVisit | null;
}

interface PurchaseOrderSupplier {
    name: string;
}

type PurchaseStatus = "draft" | "ordered" | "partially_received" | "received" | "cancelled";
type PurchaseKind = "purchase" | "refund";

export interface PurchaseOrderPdfProps {
    id: string;
    status: PurchaseStatus;
    kind: PurchaseKind;
    purchase_number: string;
    vendor_name?: string | null;
    supplier?: PurchaseOrderSupplier | null;
    purchased_at?: Date | string | null;
    subtotal?: Numeric;
    tax_amount?: Numeric;
    total?: Numeric;
    submitted_at?: Date | string | null;
    cancelled_at?: Date | string | null;
    cancellation_reason?: string | null;
    created_at: Date | string;
    qb_purchase_id?: string | null;
    lines?: PurchaseOrderLine[] | null;
    allocations?: PurchaseOrderAllocation[] | null;
}

// Same labels/colors as PURCHASE_STATUS_LABELS/COLORS in frontend/src/types/purchases.ts
const STATUS_LABELS: Record<PurchaseStatus, string> = {
    draft: "Draft",
    ordered: "Ordered",
    partially_received: "Partially received",
    received: "Received",
    cancelled: "Cancelled",
};

const STATUS_COLORS: Record<PurchaseStatus, { bg: string; text: string }> = {
    draft: { bg: "#e5e7eb", text: "#374151" },
    ordered: { bg: "#dbeafe", text: "#1d4ed8" },
    partially_received: { bg: "#fef3c7", text: "#92400e" },
    received: { bg: "#d1fae5", text: "#065f46" },
    cancelled: { bg: "#fee2e2", text: "#991b1b" },
};

// Matches PurchaseDetailsPage.tsx's own line-row builder, so the PDF reads the
// same as the app.
function jobLabel(allocation: PurchaseOrderAllocation | undefined): string {
    if (!allocation?.job) return "—";
    return allocation.job.job_number ? `#${allocation.job.job_number}` : (allocation.job.name ?? "Job");
}

function stockEffect(line: PurchaseOrderLine): string {
    if (line.disposition === "non_stock") return "Job-costed, not stocked";
    if (line.disposition === "receive") {
        return line.disposition_vehicle
            ? `${line.disposition_vehicle.name} — Added to stock`
            : "General stock — Added to stock";
    }
    return "—";
}

// ── styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
    page: {
        fontFamily: "Helvetica",
        fontSize: 9,
        color: "#111827",
        paddingTop: 40,
        paddingBottom: 60,
        paddingHorizontal: 44,
        backgroundColor: "#ffffff",
    },

    // header
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 20,
        paddingBottom: 16,
        borderBottomWidth: 2,
        borderBottomColor: "#1e3a5f",
    },
    companyBlock: {
        flexDirection: "row",
        alignItems: "flex-start",
        flex: 1,
        paddingRight: 20,
    },
    orgLogo: {
        width: 36,
        height: 36,
        marginRight: 8,
    },
    companyTextBlock: {
        flexDirection: "column",
    },
    companyName: {
        fontSize: 16,
        fontFamily: "Helvetica-Bold",
        color: "#1e3a5f",
        marginBottom: 3,
    },
    companyDetail: {
        fontSize: 8,
        color: "#6b7280",
        marginBottom: 1,
    },
    docTitleBlock: {
        alignItems: "flex-end",
        flexShrink: 0,
    },
    docTitle: {
        fontSize: 22,
        fontFamily: "Helvetica-Bold",
        color: "#1e3a5f",
        marginBottom: 4,
    },
    docNumber: { fontSize: 11, color: "#374151", fontFamily: "Helvetica-Bold" },

    // section divider
    sectionDivider: {
        borderTopWidth: 1,
        borderTopColor: "#e5e7eb",
        marginBottom: 20,
    },

    // info columns
    infoRow: {
        flexDirection: "row",
        paddingBottom: 16,
    },
    infoColLeft: {
        width: "50%",
        paddingRight: 16,
        borderRightWidth: 1,
        borderRightColor: "#e5e7eb",
    },
    infoColRight: {
        width: "50%",
        paddingLeft: 16,
    },
    sectionHeading: {
        fontSize: 9,
        fontFamily: "Helvetica-Bold",
        color: "#1e3a5f",
        textTransform: "uppercase",
        letterSpacing: 1,
        marginBottom: 7,
    },
    clientName: {
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: "#111827",
        marginBottom: 2,
    },
    infoText: { fontSize: 9, color: "#374151", marginBottom: 2 },

    // metaRow
    metaRow: { flexDirection: "row", marginBottom: 3 },
    metaLabel: { fontSize: 8, color: "#6b7280", width: 68, flexShrink: 0 },
    metaValue: {
        fontSize: 8,
        color: "#111827",
        fontFamily: "Helvetica-Bold",
        flex: 1,
    },

    // status badge
    badge: {
        paddingVertical: 2,
        paddingHorizontal: 7,
        borderRadius: 3,
        alignSelf: "flex-start",
        marginBottom: 12,
    },
    badgeText: { fontSize: 8, fontFamily: "Helvetica-Bold" },

    // table
    tableContainer: { paddingBottom: 16 },
    tableHead: {
        flexDirection: "row",
        backgroundColor: "#1e3a5f",
        paddingVertical: 7,
        paddingHorizontal: 8,
    },
    thText: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#ffffff" },
    tableRow: {
        flexDirection: "row",
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#f3f4f6",
    },
    tableRowAlt: { backgroundColor: "#f9fafb" },
    tdText: { fontSize: 9, color: "#374151" },
    tdMuted: { fontSize: 8, color: "#9ca3af", marginTop: 1 },

    // columns: 24 + 8 + 12 + 16 + 28 + 12 = 100%. Qty/Unit are right-aligned and
    // sit directly against a left-aligned column, so they need their own gutter
    // or the text touches the next column's with zero gap.
    colItem: { width: "24%" },
    colQty: { width: "8%", textAlign: "right", paddingRight: 6 },
    colUnit: { width: "12%", textAlign: "right", paddingRight: 6 },
    colJob: { width: "16%" },
    colEffect: { width: "28%" },
    colTotal: { width: "12%", textAlign: "right" },

    // totals
    tableDivider: {
        borderTopWidth: 2,
        borderTopColor: "#1e3a5f",
        marginBottom: 12,
    },
    totalsWrapper: {
        alignItems: "flex-end",
        paddingBottom: 16,
    },
    totalRow: { flexDirection: "row", width: 230, paddingVertical: 3 },
    totalLabel: {
        width: 140,
        fontSize: 9,
        color: "#6b7280",
        textAlign: "right",
        paddingRight: 14,
    },
    totalValueBold: {
        width: 90,
        fontSize: 9,
        fontFamily: "Helvetica-Bold",
        color: "#111827",
        textAlign: "right",
    },
    grandRow: {
        flexDirection: "row",
        width: 230,
        paddingTop: 6,
        marginTop: 4,
        borderTopWidth: 2,
        borderTopColor: "#1e3a5f",
    },
    grandLabel: {
        width: 140,
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: "#1e3a5f",
        textAlign: "right",
        paddingRight: 14,
    },
    grandValue: {
        width: 90,
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: "#1e3a5f",
        textAlign: "right",
    },

    // allocations
    sectionTitle: {
        fontSize: 9,
        fontFamily: "Helvetica-Bold",
        color: "#374151",
        marginBottom: 6,
    },
    allocHead: {
        flexDirection: "row",
        backgroundColor: "#f3f4f6",
        paddingVertical: 5,
        paddingHorizontal: 8,
    },
    allocRow: {
        flexDirection: "row",
        paddingVertical: 5,
        paddingHorizontal: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#f3f4f6",
    },
    // allocation cols: 40 + 40 + 20 = 100%
    allocColJob: { width: "40%" },
    allocColVisit: { width: "40%" },
    allocColAmount: { width: "20%", textAlign: "right" },

    // status overlays
    draftWatermark: {
        position: "absolute",
        top: 300,
        left: 0,
        right: 0,
        alignItems: "center",
        opacity: 0.06,
        transform: "rotate(-25deg)",
    },
    draftWatermarkText: {
        fontSize: 96,
        fontFamily: "Helvetica-Bold",
        color: "#374151",
        letterSpacing: 10,
    },
    cancelledStamp: {
        position: "absolute",
        top: 270,
        left: 0,
        right: 0,
        alignItems: "center",
        opacity: 0.22,
        transform: "rotate(-25deg)",
    },
    cancelledStampInner: {
        borderWidth: 5,
        borderColor: "#dc2626",
        borderRadius: 5,
        paddingVertical: 8,
        paddingHorizontal: 20,
    },
    cancelledStampText: {
        // "CANCELLED" is longer than DRAFT/VOID/PAID — the 76pt size those used
        // wraps it to two lines, so this stamp needs its own smaller size.
        fontSize: 52,
        fontFamily: "Helvetica-Bold",
        color: "#dc2626",
        letterSpacing: 6,
    },

    // footer
    footer: {
        position: "absolute",
        bottom: 24,
        left: 44,
        right: 44,
        borderTopWidth: 1,
        borderTopColor: "#e5e7eb",
        paddingTop: 7,
        flexDirection: "row",
        justifyContent: "space-between",
    },
    footerText: { fontSize: 7, color: "#9ca3af" },
});

// ── component ────────────────────────────────────────────────────────────────

export function PurchaseOrderPdfTemplate({ purchase, org }: { purchase: PurchaseOrderPdfProps; org: OrgPdfProps }) {
    const bc = STATUS_COLORS[purchase.status];
    const subtotal = toNum(purchase.subtotal);
    const taxAmount = toNum(purchase.tax_amount);
    const total = toNum(purchase.total);
    const allocations = purchase.allocations ?? [];
    const allocationById = new Map(allocations.map((a) => [a.id, a]));

    const docNumber = purchase.purchase_number;

    const vendorName = purchase.supplier?.name ?? purchase.vendor_name ?? "—";
    const showRawVendorName =
        purchase.supplier != null && purchase.vendor_name != null && purchase.vendor_name !== purchase.supplier.name;

    return (
        <Document>
            <Page size="A4" style={s.page}>
                {/* ── Status overlays ── */}
                {purchase.status === "draft" && (
                    <View style={s.draftWatermark}>
                        <Text style={s.draftWatermarkText}>DRAFT</Text>
                    </View>
                )}
                {purchase.status === "cancelled" && (
                    <View style={s.cancelledStamp}>
                        <View style={s.cancelledStampInner}>
                            <Text style={s.cancelledStampText} wrap={false}>CANCELLED</Text>
                        </View>
                    </View>
                )}

                {/* ── Header ── */}
                <View style={s.header}>
                    <View style={s.companyBlock}>
                        {org.logo_url && (
                            <Image src={org.logo_url} style={s.orgLogo} />
                        )}
                        <View style={s.companyTextBlock}>
                            <Text style={s.companyName}>{org.name}</Text>
                            {org.address && <Text style={s.companyDetail}>{org.address}</Text>}
                            {org.phone && <Text style={s.companyDetail}>{org.phone}</Text>}
                            {org.email && <Text style={s.companyDetail}>{org.email}</Text>}
                            {org.website && <Text style={s.companyDetail}>{org.website}</Text>}
                        </View>
                    </View>
                    <View style={s.docTitleBlock}>
                        <Text style={s.docTitle}>PURCHASE ORDER</Text>
                        <Text style={s.docNumber}>{docNumber}</Text>
                    </View>
                </View>

                {/* ── Vendor + Purchase Details ── */}
                <View style={s.infoRow}>
                    <View style={s.infoColLeft}>
                        <Text style={s.sectionHeading}>Vendor</Text>
                        <Text style={s.clientName}>{vendorName}</Text>
                        {showRawVendorName && (
                            <Text style={s.infoText}>As entered: {purchase.vendor_name}</Text>
                        )}
                    </View>

                    <View style={s.infoColRight}>
                        <Text style={s.sectionHeading}>Purchase Details</Text>
                        <View style={[s.badge, { backgroundColor: bc.bg }]}>
                            <Text style={[s.badgeText, { color: bc.text }]}>{STATUS_LABELS[purchase.status]}</Text>
                        </View>
                        {purchase.kind === "refund" && (
                            <View style={s.metaRow}>
                                <Text style={s.metaLabel}>Type</Text>
                                <Text style={s.metaValue}>Refund</Text>
                            </View>
                        )}
                        <View style={s.metaRow}>
                            <Text style={s.metaLabel}>Purchased</Text>
                            <Text style={s.metaValue}>{fmtDate(purchase.purchased_at ?? purchase.created_at)}</Text>
                        </View>
                        {purchase.submitted_at && (
                            <View style={s.metaRow}>
                                <Text style={s.metaLabel}>Submitted</Text>
                                <Text style={s.metaValue}>{fmtDate(purchase.submitted_at)}</Text>
                            </View>
                        )}
                        {purchase.cancelled_at && (
                            <View style={s.metaRow}>
                                <Text style={s.metaLabel}>Cancelled</Text>
                                <Text style={s.metaValue}>{fmtDate(purchase.cancelled_at)}</Text>
                            </View>
                        )}
                        {purchase.cancellation_reason && (
                            <View style={[s.metaRow, { marginTop: 6 }]}>
                                <Text style={s.metaLabel}>Reason</Text>
                                <Text style={s.metaValue}>{purchase.cancellation_reason}</Text>
                            </View>
                        )}
                    </View>
                </View>

                {/* ── Line Items ── */}
                <View style={s.tableContainer}>
                    <View style={s.tableHead}>
                        <View style={s.colItem}>
                            <Text style={s.thText}>Item</Text>
                        </View>
                        <View style={s.colQty}>
                            <Text style={[s.thText, { textAlign: "right" }]}>Qty</Text>
                        </View>
                        <View style={s.colUnit}>
                            <Text style={[s.thText, { textAlign: "right" }]}>Unit Price</Text>
                        </View>
                        <View style={s.colJob}>
                            <Text style={s.thText}>Job</Text>
                        </View>
                        <View style={s.colEffect}>
                            <Text style={s.thText}>Effect on Stock</Text>
                        </View>
                        <View style={s.colTotal}>
                            <Text style={[s.thText, { textAlign: "right" }]}>Total</Text>
                        </View>
                    </View>

                    {(purchase.lines ?? []).map((line, i) => {
                        const allocation = line.allocation_id ? allocationById.get(line.allocation_id) : undefined;
                        return (
                            <View
                                key={line.id ?? i}
                                style={[s.tableRow, i % 2 === 1 ? s.tableRowAlt : {}]}
                                wrap={false}
                            >
                                <View style={s.colItem}>
                                    <Text style={s.tdText}>{line.description}</Text>
                                    {line.inventory_item?.sku && (
                                        <Text style={s.tdMuted}>{line.inventory_item.sku}</Text>
                                    )}
                                </View>
                                <View style={s.colQty}>
                                    <Text style={[s.tdText, { textAlign: "right" }]}>{toNum(line.quantity)}</Text>
                                </View>
                                <View style={s.colUnit}>
                                    <Text style={[s.tdText, { textAlign: "right" }]}>{fmt(line.unit_price)}</Text>
                                </View>
                                <View style={s.colJob}>
                                    <Text style={s.tdText}>{jobLabel(allocation)}</Text>
                                </View>
                                <View style={s.colEffect}>
                                    <Text style={s.tdText}>{stockEffect(line)}</Text>
                                </View>
                                <View style={s.colTotal}>
                                    <Text style={[s.tdText, { textAlign: "right" }]}>{fmt(line.line_total)}</Text>
                                </View>
                            </View>
                        );
                    })}
                </View>

                {/* ── Totals ── */}
                <View style={s.tableDivider} />
                <View style={s.totalsWrapper}>
                    <View style={s.totalRow}>
                        <Text style={s.totalLabel}>Subtotal</Text>
                        <Text style={s.totalValueBold}>{fmt(subtotal)}</Text>
                    </View>

                    {taxAmount > 0 && (
                        <View style={s.totalRow}>
                            <Text style={s.totalLabel}>Tax</Text>
                            <Text style={s.totalValueBold}>{fmt(taxAmount)}</Text>
                        </View>
                    )}

                    <View style={s.grandRow}>
                        <Text style={s.grandLabel}>Total</Text>
                        <Text style={s.grandValue}>{fmt(total)}</Text>
                    </View>
                </View>

                {/* ── Job Allocations ── */}
                {allocations.length > 0 && (
                    <>
                        <View style={s.sectionDivider} />
                        <View>
                            <Text style={s.sectionTitle}>Job Allocations</Text>
                            <View style={s.allocHead}>
                                <View style={s.allocColJob}>
                                    <Text style={s.thText}>Job</Text>
                                </View>
                                <View style={s.allocColVisit}>
                                    <Text style={s.thText}>Visit</Text>
                                </View>
                                <View style={s.allocColAmount}>
                                    <Text style={[s.thText, { textAlign: "right" }]}>Amount</Text>
                                </View>
                            </View>
                            {allocations.map((a, i) => (
                                <View key={a.id ?? i} style={s.allocRow} wrap={false}>
                                    <View style={s.allocColJob}>
                                        <Text style={s.tdText}>{jobLabel(a)}</Text>
                                    </View>
                                    <View style={s.allocColVisit}>
                                        <Text style={s.tdText}>{a.job_visit?.name ?? "—"}</Text>
                                    </View>
                                    <View style={s.allocColAmount}>
                                        <Text style={[s.tdText, { textAlign: "right" }]}>{fmt(a.amount)}</Text>
                                    </View>
                                </View>
                            ))}
                        </View>
                    </>
                )}

                {/* ── Footer ── */}
                <View style={s.footer} fixed>
                    <Text style={s.footerText}>{org.name}</Text>
                    <Text
                        style={s.footerText}
                        render={({ pageNumber, totalPages }) =>
                            `Page ${pageNumber} of ${totalPages}`
                        }
                    />
                </View>
            </Page>
        </Document>
    );
}
