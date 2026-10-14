import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import type { TaxSnapshot } from "../../services/taxEngine.js";
import { type Numeric, type OrgPdfProps, toNum, fmt, fmtDate, fmtRatePct } from "./pdfHelpers.js";

// ── PDF prop types ────────────────────────────────────────────────────────────

interface QuotePdfLineItem {
	id?: string;
	name: string;
	description?: string | null;
	quantity: Numeric;
	unit_price: Numeric;
	total: Numeric;
	taxable?: boolean | null;
	tax_group?: { name: string } | null;
}

interface QuotePdfNote {
	id?: string;
	content: string;
}

interface QuotePdfClient {
	name?: string | null;
	address?: string | null;
	contacts?: Array<{
		contact: {
			name?: string | null;
			email?: string | null;
			phone?: string | null;
		};
	}> | null;
}

interface QuotePdfProps {
	status: string;
	quote_number: string;
	created_at: Date | string;
	valid_until?: Date | string | null;
	title?: string | null;
	subtotal?: Numeric;
	discount_value?: Numeric;
	discount_amount?: Numeric;
	discount_type?: string | null;
	tax_amount?: Numeric;
	tax_rate?: Numeric;
	tax_snapshot?: TaxSnapshot | null;
	total?: Numeric;
	client?: QuotePdfClient | null;
	line_items?: QuotePdfLineItem[] | null;
	notes?: QuotePdfNote[] | null;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
	Draft:     { bg: "#e5e7eb", text: "#374151" },
	Issued:    { bg: "#dbeafe", text: "#1d4ed8" },
	Sent:      { bg: "#dcfce7", text: "#166534" },
	Viewed:    { bg: "#ccfbf1", text: "#0f766e" },
	Approved:  { bg: "#d1fae5", text: "#065f46" },
	Rejected:  { bg: "#fee2e2", text: "#991b1b" },
	Revised:   { bg: "#fef3c7", text: "#92400e" },
	Expired:   { bg: "#ffedd5", text: "#9a3412" },
	Cancelled: { bg: "#fee2e2", text: "#991b1b" },
};

// Sent and Viewed are internal workflow states ─ not meaningful to the quote recipient
const HIDE_BADGE_STATUSES = new Set(["Sent", "Viewed"]);

// Enum values are DB-frozen; these are the display strings, matching the
// app's QuoteStatusLabels. Issued reads "Created".
const STATUS_LABELS: Record<string, string> = {
	Draft: "Draft",
	Issued: "Created",
	Sent: "Sent",
	Viewed: "Viewed",
	Approved: "Approved",
	Disputed: "Disputed",
	Rejected: "Rejected",
	Revised: "Revised",
	Expired: "Expired",
	Cancelled: "Cancelled",
};

const badgeColors = (status: string) =>
	STATUS_COLORS[status] ?? { bg: "#f3f4f6", text: "#6b7280" };

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
	// Section heading ─ used for BILL TO and QUOTE DETAILS titles
	sectionHeading: {
		fontSize: 9,
		fontFamily: "Helvetica-Bold",
		color: "#1e3a5f",
		textTransform: "uppercase",
		letterSpacing: 1,
		marginBottom: 7,
	},
	// Small muted label ─ kept for legacy use if needed
	sectionLabel: {
		fontSize: 7,
		fontFamily: "Helvetica-Bold",
		color: "#6b7280",
		marginBottom: 5,
		textTransform: "uppercase",
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

	// columns: 36 + 30 + 10 + 12 + 12 = 100%
	colName: { width: "36%" },
	colDesc: { width: "30%" },
	colQty: { width: "10%", textAlign: "right" },
	colUnit: { width: "12%", textAlign: "right" },
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
	totalRow: {
		flexDirection: "row",
		width: 230,
		paddingVertical: 3,
	},
	totalLabel: {
		width: 140,
		fontSize: 9,
		color: "#6b7280",
		textAlign: "right",
		paddingRight: 14,
	},
	totalValue: {
		width: 90,
		fontSize: 9,
		color: "#111827",
		textAlign: "right",
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

	// notes section title
	sectionTitle: {
		fontSize: 9,
		fontFamily: "Helvetica-Bold",
		color: "#374151",
		marginBottom: 6,
	},
	noteBox: {
		backgroundColor: "#f9fafb",
		borderLeftWidth: 3,
		borderLeftColor: "#1e3a5f",
		paddingVertical: 6,
		paddingHorizontal: 10,
		marginBottom: 6,
	},
	noteText: { fontSize: 9, color: "#374151", lineHeight: 1.5 },

	// draft watermark
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

export function QuotePdfTemplate({ quote, org }: { quote: QuotePdfProps; org: OrgPdfProps }) {
	const bc = badgeColors(quote.status);
	const contact = quote.client?.contacts?.[0]?.contact;

	const subtotal = toNum(quote.subtotal);
	const discountValue = toNum(quote.discount_value);
	// discount_amount is the calculated dollar discount (for percent discounts, discount_value is
	// the raw percentage input like 20, not the dollar amount); fall back to discount_value for
	// backward-compat with amount-type discounts where both fields equal the same dollar figure.
	const discountDisplayAmount = toNum(quote.discount_amount ?? quote.discount_value);
	const taxAmount = toNum(quote.tax_amount);

	// Map group name → combined rate for line item subtitles; falls back gracefully when
	// no snapshot exists (draft docs or legacy records).
	const groupRateMap = new Map<string, number>();
	for (const group of quote.tax_snapshot?.groups ?? []) {
		const combined = (group.rates ?? []).reduce((sum, r) => sum + r.rate, 0);
		if (combined > 0) groupRateMap.set(group.name, combined);
	}
	const total = toNum(quote.total);
	const taxRate = toNum(quote.tax_rate);

	return (
		<Document>
			<Page size="A4" style={s.page}>
				{/* ── Draft watermark ── */}
				{quote.status === "Draft" && (
					<View style={s.draftWatermark}>
						<Text style={s.draftWatermarkText}>DRAFT</Text>
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
						<Text style={s.docTitle}>QUOTE</Text>
						<Text style={s.docNumber}>{quote.quote_number}</Text>
					</View>
				</View>

				{/* ── Bill To + Quote Details ── */}
				<View style={s.infoRow}>
					<View style={s.infoColLeft}>
						<Text style={s.sectionHeading}>Bill To</Text>
						<Text style={s.clientName}>{quote.client?.name ?? "─"}</Text>
						{quote.client?.address && (
							<Text style={s.infoText}>{quote.client.address}</Text>
						)}
						{contact?.name && <Text style={s.infoText}>{contact.name}</Text>}
						{contact?.email && <Text style={s.infoText}>{contact.email}</Text>}
						{contact?.phone && <Text style={s.infoText}>{contact.phone}</Text>}
					</View>

					<View style={s.infoColRight}>
						<Text style={s.sectionHeading}>Quote Details</Text>
						{!HIDE_BADGE_STATUSES.has(quote.status) && (
							<View style={[s.badge, { backgroundColor: bc.bg }]}>
								<Text style={[s.badgeText, { color: bc.text }]}>{STATUS_LABELS[quote.status] ?? quote.status}</Text>
							</View>
						)}
						<View style={s.metaRow}>
							<Text style={s.metaLabel}>Date</Text>
							<Text style={s.metaValue}>{fmtDate(quote.created_at)}</Text>
						</View>
						{quote.valid_until && (
							<View style={s.metaRow}>
								<Text style={s.metaLabel}>Valid Until</Text>
								<Text style={s.metaValue}>{fmtDate(quote.valid_until)}</Text>
							</View>
						)}
						{quote.title && (
							<View style={[s.metaRow, { marginTop: 6 }]}>
								<Text style={s.metaLabel}>Subject</Text>
								<Text style={s.metaValue}>{quote.title}</Text>
							</View>
						)}
					</View>
				</View>

				{/* ── Line Items ── */}
				<View style={s.tableContainer}>
					<View style={s.tableHead}>
						<View style={s.colName}>
							<Text style={s.thText}>Item</Text>
						</View>
						<View style={s.colDesc}>
							<Text style={s.thText}>Description</Text>
						</View>
						<View style={s.colQty}>
							<Text style={[s.thText, { textAlign: "right" }]}>Qty</Text>
						</View>
						<View style={s.colUnit}>
							<Text style={[s.thText, { textAlign: "right" }]}>Unit Price</Text>
						</View>
						<View style={s.colTotal}>
							<Text style={[s.thText, { textAlign: "right" }]}>Total</Text>
						</View>
					</View>

					{(quote.line_items ?? []).map((item: QuotePdfLineItem, i: number) => (
						<View
							key={item.id ?? i}
							style={[s.tableRow, i % 2 === 1 ? s.tableRowAlt : {}]}
							wrap={false}
						>
							<View style={s.colName}>
								<Text style={s.tdText}>{item.name}</Text>
								{item.tax_group?.name && (
									<Text style={{ fontSize: 7, color: "#9ca3af", marginTop: 1 }}>
										{item.tax_group.name}
										{groupRateMap.has(item.tax_group.name)
											? ` (${fmtRatePct(groupRateMap.get(item.tax_group.name)!)})`
											: ""}
									</Text>
								)}
								{item.taxable === false && !item.tax_group?.name && (
									<Text style={{ fontSize: 7, color: "#9ca3af", marginTop: 1 }}>
										Non-taxable
									</Text>
								)}
							</View>
							<View style={s.colDesc}>
								{item.description ? (
									<Text style={s.tdMuted}>{item.description}</Text>
								) : null}
							</View>
							<View style={s.colQty}>
								<Text style={[s.tdText, { textAlign: "right" }]}>
									{toNum(item.quantity)}
								</Text>
							</View>
							<View style={s.colUnit}>
								<Text style={[s.tdText, { textAlign: "right" }]}>
									{fmt(item.unit_price)}
								</Text>
							</View>
							<View style={s.colTotal}>
								<Text style={[s.tdText, { textAlign: "right" }]}>
									{fmt(item.total)}
								</Text>
							</View>
						</View>
					))}
				</View>

				{/* ── Totals ── */}
				<View style={s.tableDivider} />
				<View style={s.totalsWrapper}>
					<View style={s.totalRow}>
						<Text style={s.totalLabel}>Subtotal</Text>
						<Text style={s.totalValueBold}>{fmt(subtotal)}</Text>
					</View>

					{discountDisplayAmount > 0 && (
						<View style={s.totalRow}>
							<Text style={s.totalLabel}>
								Discount
								{quote.discount_type === "percent"
									? ` (${discountValue}%)`
									: ""}
							</Text>
							<Text style={[s.totalValue, { color: "#059669" }]}>
								-{fmt(discountDisplayAmount)}
							</Text>
						</View>
					)}

					{quote.tax_snapshot != null ? (
						quote.tax_snapshot.client_exempt ? (
							<View style={s.totalRow}>
								<Text style={s.totalLabel}>Tax</Text>
								<Text style={s.totalValue}>Tax Exempt</Text>
							</View>
						) : (
							<>
								{(quote.tax_snapshot.groups ?? []).map((group) => {
									const combinedRate = (group.rates ?? []).reduce(
										(sum, r) => sum + r.rate,
										0,
									);
									return (
										<View key={group.id} style={s.totalRow}>
											<Text style={s.totalLabel}>
												{group.name}
												{combinedRate > 0 ? ` (${fmtRatePct(combinedRate)})` : ""}
											</Text>
											<Text style={s.totalValue}>
												{fmt((group.tax_amount_cents ?? 0) / 100)}
											</Text>
										</View>
									);
								})}
								{(quote.tax_snapshot.groups ?? []).length > 1 && (
									<View style={s.totalRow}>
										<Text style={s.totalLabel}>Total Tax</Text>
										<Text style={s.totalValueBold}>
											{fmt((quote.tax_snapshot.total_tax_cents ?? 0) / 100)}
										</Text>
									</View>
								)}
							</>
						)
					) : (
						taxAmount > 0 && (
							<View style={s.totalRow}>
								<Text style={s.totalLabel}>Tax ({fmtRatePct(taxRate)})</Text>
								<Text style={s.totalValue}>{fmt(taxAmount)}</Text>
							</View>
						)
					)}

					<View style={s.grandRow}>
						<Text style={s.grandLabel}>Total</Text>
						<Text style={s.grandValue}>{fmt(total)}</Text>
					</View>
				</View>

				{/* ── Notes ── */}
				{(quote.notes ?? []).length > 0 && (
					<>
						<View style={s.sectionDivider} />
						<View>
							<Text style={s.sectionTitle}>Notes</Text>
							{(quote.notes ?? []).map((note: QuotePdfNote, i: number) => (
								<View key={note.id ?? i} style={s.noteBox}>
									<Text style={s.noteText}>{note.content}</Text>
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
