import { useState } from "react";
import { getPublicDocumentPdf, type PublicLineItem } from "../../api/publicLinks";
import { formatCurrency } from "../../util/util";
import { secondaryButtonClass } from "./publicStyles";

export function PublicLineItems({ items }: { items: PublicLineItem[] }) {
	return (
		<ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
			{items.map((li, i) => (
				<li key={i} className="flex items-start justify-between gap-4 py-3">
					<div className="min-w-0">
						<p className="break-words text-sm font-medium">
							{li.name}
						</p>
						{li.description && (
							<p className="mt-0.5 break-words text-sm text-zinc-600 dark:text-zinc-400">
								{li.description}
							</p>
						)}
						{li.quantity !== 1 && (
							<p className="mt-0.5 text-xs tabular-nums text-zinc-500">
								{li.quantity} ×{" "}
								{formatCurrency(li.unit_price)}
							</p>
						)}
					</div>
					<p className="shrink-0 text-sm font-medium tabular-nums">
						{formatCurrency(li.total)}
					</p>
				</li>
			))}
		</ul>
	);
}

export function TotalRow({
	label,
	amount,
	strong,
}: {
	label: string;
	amount: number;
	strong?: boolean;
}) {
	return (
		<div
			className={`flex justify-between tabular-nums ${
				strong
					? "text-base font-semibold"
					: "text-sm text-zinc-600 dark:text-zinc-400"
			}`}
		>
			<dt>{label}</dt>
			<dd>{formatCurrency(amount)}</dd>
		</div>
	);
}

export function PdfButton({ token, filename }: { token: string; filename: string }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);

	// Fetched as a blob because the token rides in the POST body, never the URL.
	const download = async () => {
		setBusy(true);
		setError(false);
		try {
			const blob = await getPublicDocumentPdf(token);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-2">
			<button
				type="button"
				onClick={download}
				disabled={busy}
				className={secondaryButtonClass}
			>
				{busy ? "Preparing PDF…" : "Download PDF"}
			</button>
			{error && (
				<p
					role="alert"
					className="text-center text-sm text-red-600 dark:text-red-400"
				>
					Could not download the PDF. Try again.
				</p>
			)}
		</div>
	);
}
