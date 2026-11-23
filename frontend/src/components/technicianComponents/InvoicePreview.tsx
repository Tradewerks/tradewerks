import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VisitLineItem } from "../../types/jobs";

interface InvoicePreviewProps {
	lineItems: VisitLineItem[];
	subtotal: number;
	taxRate: number;
	taxAmount: number;
	total: number;
	isCompleted?: boolean;
}

export default function InvoicePreview({
	lineItems,
	subtotal,
	taxRate,
	taxAmount,
	total,
	isCompleted,
}: InvoicePreviewProps) {
	const { t } = useTranslation();
	return (
		<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
			<div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
					{t("invoicePreview.title")}
				</span>
				{isCompleted && (
					<span className="flex items-center gap-1.5 text-[11px] font-medium text-success-text">
						<CheckCircle2 size={12} />
						{t("invoicePreview.ready")}
					</span>
				)}
			</div>

			{lineItems.length === 0 ? (
				<p className="px-4 py-6 text-center text-sm text-text-faint">{t("invoicePreview.noItems")}</p>
			) : (
				<>
					{/* Line items */}
					<div className="divide-y divide-border-subtle">
						{lineItems.map((item, idx) => {
							const lineTotal = Number(item.quantity) * Number(item.unit_price);
							return (
								<div key={item.id ?? idx} className="flex items-center gap-3 px-4 py-2.5">
									<div className="flex-1 min-w-0">
										<p className="text-sm text-text-primary truncate" title={item.name}>{item.name}</p>
										{item.description && (
											<p className="text-xs text-text-faint truncate" title={item.description}>{item.description}</p>
										)}
									</div>
									<div className="text-right shrink-0">
										<p className="text-xs text-text-muted tabular-nums">
											{Number(item.quantity)} × ${Number(item.unit_price).toFixed(2)}
										</p>
										<p className="text-sm font-medium text-text-primary tabular-nums">
											${lineTotal.toFixed(2)}
										</p>
									</div>
								</div>
							);
						})}
					</div>

					{/* Totals */}
					<div className="px-4 py-3 space-y-1.5 border-t border-border-subtle">
						<div className="flex justify-between text-sm text-text-tertiary">
							<span>{t("invoicePreview.subtotal")}</span>
							<span className="tabular-nums">${subtotal.toFixed(2)}</span>
						</div>
						{taxRate > 0 && (
							<div className="flex justify-between text-sm text-text-tertiary">
								<span>{t("invoicePreview.tax", { rate: taxRate })}</span>
								<span className="tabular-nums">${taxAmount.toFixed(2)}</span>
							</div>
						)}
						<div className="flex justify-between text-base font-bold text-text-primary pt-1 border-t border-border-subtle">
							<span>{t("invoicePreview.total")}</span>
							<span className="tabular-nums">${total.toFixed(2)}</span>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
