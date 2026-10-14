import { X, MapPin, Calendar, AlertCircle } from "lucide-react";
import { useQuoteByIdQuery } from "../../hooks/useQuotes";
import { QuoteStatusColors, QuoteStatusLabels } from "../../types/quotes";
import { formatDateTime } from "../../util/util";

interface TechnicianQuoteModalProps {
	quoteId: string;
	onClose: () => void;
}

const fmt = (n: number) =>
	Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function TechnicianQuoteModal({ quoteId, onClose }: TechnicianQuoteModalProps) {
	const { data: quote, isLoading } = useQuoteByIdQuery(quoteId);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/70 backdrop-blur-sm"
			onClick={onClose}
		>
			<div
				className="relative w-full max-w-2xl max-h-[90svh] flex flex-col bg-base border border-border/80 rounded-xl overflow-hidden shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="shrink-0 flex items-start justify-between gap-4 p-5 border-b border-border-subtle bg-base/95 backdrop-blur-sm">
					<div className="min-w-0 flex-1">
						{isLoading || !quote ? (
							<div className="h-6 w-48 bg-surface-raised rounded animate-pulse" />
						) : (
							<>
								<p className="text-text-muted text-xs mb-1">Quote #{quote.quote_number}</p>
								<h2 className="text-text-primary text-lg font-semibold leading-tight break-words">{quote.title}</h2>
								<span
									className={`inline-flex items-center mt-2 px-2.5 py-0.5 rounded-full text-xs font-medium border ${
										QuoteStatusColors[quote.status] ??
										"bg-neutral/20 text-text-secondary border-border-strong/30"
									}`}
								>
									{QuoteStatusLabels[quote.status] ?? quote.status}
								</span>
							</>
						)}
					</div>
					<button
						onClick={onClose}
						className="shrink-0 p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors"
					>
						<X size={18} />
					</button>
				</div>

				{isLoading || !quote ? (
					<div className="flex-1 flex items-center justify-center h-40">
						<div className="text-text-tertiary text-sm animate-pulse">Loading quote...</div>
					</div>
				) : (
					<div className="flex-1 overflow-y-auto p-5 space-y-5 pb-8">
						{/* Rejection reason */}
						{quote.status === "Rejected" && quote.rejection_reason && (
							<div className="flex gap-3 p-3 rounded-lg bg-error/10 border border-error/30">
								<AlertCircle size={16} className="text-error-text shrink-0 mt-0.5" />
								<div className="min-w-0">
									<p className="text-error-text text-xs font-medium mb-0.5">Rejection Reason</p>
									<p className="text-error-text text-sm break-words">{quote.rejection_reason}</p>
								</div>
							</div>
						)}

						{/* Description */}
						{quote.description && (
							<div>
								<h3 className="text-text-muted text-xs font-medium uppercase tracking-wider mb-1.5">Description</h3>
								<p className="text-text-primary text-sm whitespace-pre-wrap break-words leading-relaxed">{quote.description}</p>
							</div>
						)}

						{/* Address */}
						{quote.address && (
							<div className="flex gap-2 items-start">
								<MapPin size={14} className="text-text-tertiary mt-0.5 shrink-0" />
								<div className="min-w-0">
									<h3 className="text-text-muted text-xs font-medium uppercase tracking-wider mb-0.5">Address</h3>
									<p className="text-text-primary text-sm break-words">{quote.address}</p>
								</div>
							</div>
						)}

						{/* Line Items */}
						{quote.line_items && quote.line_items.length > 0 && (
							<div>
								<h3 className="text-text-muted text-xs font-medium uppercase tracking-wider mb-2">Line Items</h3>
								<div className="rounded-lg border border-border/80 overflow-hidden">
									<div className="overflow-x-auto">
										<table className="w-full min-w-[360px] text-sm table-fixed">
											<colgroup>
												<col style={{ width: "43%" }} />
												<col style={{ width: "12%" }} />
												<col style={{ width: "22%" }} />
												<col style={{ width: "24%" }} />
											</colgroup>
											<thead>
												<tr className="bg-surface/80 text-text-tertiary text-xs">
													<th className="text-left px-3 py-2 font-medium">Item</th>
													<th className="text-right px-3 py-2 font-medium">Qty</th>
													<th className="text-right px-3 py-2 font-medium">Price</th>
													<th className="text-right pl-3 pr-4 py-2 font-medium">Total</th>
												</tr>
											</thead>
											<tbody className="divide-y divide-border/50">
												{quote.line_items.map((item) => (
													<tr key={item.id} className="text-text-primary hover:bg-surface/40 transition-colors duration-100">
														<td className="px-3 py-2.5 min-w-0">
															<p className="font-medium break-words leading-snug">{item.name}</p>
															{item.description && (
																<p className="text-text-tertiary text-xs mt-0.5 break-words leading-snug">{item.description}</p>
															)}
														</td>
														<td className="px-3 py-2.5 text-right text-text-secondary tabular-nums">{item.quantity}</td>
														<td className="px-3 py-2.5 text-right text-text-secondary tabular-nums">${fmt(item.unit_price)}</td>
														<td className="pl-3 pr-4 py-2.5 text-right font-medium tabular-nums">${fmt(item.total)}</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							</div>
						)}

						{/* Pricing Summary */}
						<div>
							<h3 className="text-text-muted text-xs font-medium uppercase tracking-wider mb-2">Pricing</h3>
							<div className="rounded-lg border border-border/80 overflow-hidden">
								<div className="divide-y divide-border/50">
									<div className="flex justify-between px-4 py-2.5 text-sm">
										<span className="text-text-tertiary">Subtotal</span>
										<span className="text-text-primary tabular-nums">${fmt(quote.subtotal)}</span>
									</div>
									{Number(quote.tax_amount) > 0 && (
										<div className="flex justify-between px-4 py-2.5 text-sm">
											<span className="text-text-tertiary">
												Tax {quote.tax_rate ? `(${(Number(quote.tax_rate) * 100).toFixed(1)}%)` : ""}
											</span>
											<span className="text-text-primary tabular-nums">${fmt(quote.tax_amount)}</span>
										</div>
									)}
									{Number(quote.discount_amount) > 0 && (
										<div className="flex justify-between px-4 py-2.5 text-sm">
											<span className="text-text-tertiary">Discount</span>
											<span className="text-success-text tabular-nums">-${fmt(quote.discount_amount)}</span>
										</div>
									)}
									<div className="flex justify-between px-4 py-3 bg-surface/60 text-base font-semibold">
										<span className="text-text-primary">Total</span>
										<span className="text-text-primary tabular-nums">${fmt(quote.total)}</span>
									</div>
								</div>
							</div>
						</div>

						{/* Dates */}
						{(quote.valid_until || quote.expires_at) && (
							<div className="flex gap-2 items-start">
								<Calendar size={14} className="text-text-tertiary mt-0.5 shrink-0" />
								<div className="space-y-1">
									{quote.valid_until && (
										<p className="text-text-tertiary text-sm">
											Valid until:{" "}
											<span className="text-text-primary">{formatDateTime(quote.valid_until)}</span>
										</p>
									)}
									{quote.expires_at && (
										<p className="text-text-tertiary text-sm">
											Expires:{" "}
											<span className="text-text-primary">{formatDateTime(quote.expires_at)}</span>
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
