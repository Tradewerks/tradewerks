import { useEffect, useRef } from "react";
import { markPublicLinkViewed, type InvoiceLinkData } from "../../api/publicLinks";
import { PdfButton, PublicLineItems, TotalRow } from "./PublicDocumentParts";
import { formatPublicDay } from "./publicStyles";

interface Props {
	token: string;
	data: InvoiceLinkData;
}

export default function InvoiceView({ token, data }: Props) {
	const viewed = useRef(false);
	useEffect(() => {
		if (viewed.current) return;
		viewed.current = true;
		// Best effort: failing to record a view must never disturb the customer.
		markPublicLinkViewed(token).catch(() => {});
	}, [token]);

	// publicViews emits "Void" verbatim; paid-ness comes from the balance, not a label.
	const isVoid = data.status_label === "Void";
	const settled = isVoid || data.balance_due <= 0;
	const phone = data.org.phone;

	return (
		<div className="space-y-5">
			<div>
				<p className="text-sm text-zinc-500">Invoice {data.number}</p>
				<h1 className="mt-0.5 text-xl font-semibold">
					{data.status_label}
				</h1>
				<p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
					{[
						data.issue_date &&
							`Issued ${formatPublicDay(data.issue_date)}`,
						data.due_date &&
							!settled &&
							`Due ${formatPublicDay(data.due_date)}`,
					]
						.filter(Boolean)
						.join(" · ")}
				</p>
			</div>

			<PublicLineItems items={data.line_items} />

			<dl className="space-y-1.5">
				<TotalRow label="Total" amount={data.total} />
				{data.amount_paid > 0 && (
					<TotalRow label="Paid" amount={-data.amount_paid} />
				)}
				<TotalRow label="Balance due" amount={data.balance_due} strong />
			</dl>

			{!settled && (
				<p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
					To pay, contact {data.org.name}
					{phone ? ` at ${phone}` : ""}.
				</p>
			)}

			{!isVoid && (
				<PdfButton token={token} filename={`invoice-${data.number}.pdf`} />
			)}
		</div>
	);
}
