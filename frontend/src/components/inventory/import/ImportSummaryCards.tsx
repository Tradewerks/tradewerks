import { AlertTriangle, CircleHelp, MinusCircle, Plus, RefreshCw } from "lucide-react";
import type { InventoryImport } from "../../../types/inventoryImport";

const cards = [
	{ key: "create_count", label: "New items", icon: Plus, color: "text-success" },
	{ key: "update_count", label: "Existing items changed", icon: RefreshCw, color: "text-link" },
	{ key: "skip_count", label: "Won't be imported", icon: MinusCircle, color: "text-muted" },
	{ key: "conflict_count", label: "Need your review", icon: AlertTriangle, color: "text-warning-text" },
	{ key: "low_confidence_count", label: "Uncertain suggestions", icon: CircleHelp, color: "text-warning-text" },
] as const;

export default function ImportSummaryCards({ record }: { record: InventoryImport }) {
	return (
		<section aria-labelledby="import-plan-heading" className="overflow-hidden rounded-xl border border-border bg-base">
			<div className="border-b border-border-subtle px-5 py-4">
				<h2 id="import-plan-heading" className="font-medium text-text-primary">What this import will do</h2>
				<p className="mt-1 text-sm text-muted">These numbers update as you review each item.</p>
			</div>
			<dl className="grid grid-cols-2 divide-x divide-y divide-border-subtle md:grid-cols-5 md:divide-y-0">
			{cards.map(({ key, label, icon: Icon, color }) => (
				<div key={key} className="min-w-0 px-4 py-4">
					<div className="flex items-center justify-between">
						<dt className="text-xs leading-4 text-muted">{label}</dt>
						<Icon size={15} className={color} />
					</div>
					<dd className="mt-2 text-2xl font-semibold tabular-nums text-text-primary">{record[key]}</dd>
				</div>
			))}
			</dl>
		</section>
	);
}
