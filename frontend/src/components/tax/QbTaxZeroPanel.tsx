import { AlertTriangle, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import type { QbTaxZero } from "../../types/tax";

interface QbTaxZeroPanelProps {
	zero: QbTaxZero;
	onClose: () => void;
}

/** QuickBooks answered with no tax on lines the invoice taxes; the fix lives in QuickBooks. */
export default function QbTaxZeroPanel({ zero, onClose }: QbTaxZeroPanelProps) {
	const content = (
		<div className="flex min-h-0 flex-col">
			<div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
				<h2 className="text-base font-semibold text-primary">QuickBooks tax check</h2>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="rounded-md p-1.5 text-text-tertiary transition-colors duration-150 ease-out hover:bg-surface hover:text-text-primary"
				>
					<X size={16} />
				</button>
			</div>
			<div className="min-h-0 space-y-3 overflow-y-auto px-6 py-5">
				<div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg p-3">
					<AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-warning-text" />
					<p className="text-sm text-warning-text">
						QuickBooks charged no tax. Check the sales tax category on these QuickBooks items:{" "}
						{zero.items.join(", ")}
					</p>
				</div>
				<p className="text-xs text-text-secondary">
					Open each item in QuickBooks and set the sales tax category in QuickBooks, then try
					again. If a line should not be taxed, mark it not taxable on this invoice instead.
				</p>
			</div>
			<div className="flex items-center justify-end border-t border-border-subtle px-6 py-4">
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-4 py-2 text-sm text-text-secondary transition-colors duration-150 ease-out hover:bg-surface hover:text-text-primary"
				>
					Got it
				</button>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen onClose={onClose} size="md" />;
}
