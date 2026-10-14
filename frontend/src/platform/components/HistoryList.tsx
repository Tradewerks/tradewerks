import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { platformError } from "../api";
import { chip } from "./orgDetailUi";
import SkeletonRows from "./SkeletonRows";
import type { HistoryRow } from "../types";

export default function HistoryList({
	rows,
	isLoading,
	error,
	eventLabels,
}: {
	rows?: HistoryRow[];
	isLoading: boolean;
	error: unknown;
	eventLabels: Record<string, string>;
}) {
	if (isLoading) return <SkeletonRows />;
	if (error) return <FormErrorBanner message={platformError(error)} />;
	if (!rows?.length) return <p className="text-sm text-text-secondary">No changes yet.</p>;
	return (
		<ul className="space-y-2">
			{rows.map((h) => (
				<li
					key={h.id}
					className="space-y-1 rounded-lg border border-border bg-surface p-3"
				>
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="font-medium text-text-primary">
							{eventLabels[h.event_type] ?? h.event_type}
						</span>
						<span className="text-text-secondary">
							{h.staff_name ?? h.actor_name ?? "System"}
						</span>
						{h.actor_type === "platform_staff" && (
							<span className={chip}>TradeWerks</span>
						)}
						<span className="ml-auto text-xs text-text-tertiary tabular-nums">
							{new Date(h.timestamp).toLocaleString()}
						</span>
					</div>
					{h.reason && (
						<p className="text-sm text-text-secondary">
							{h.reason}
						</p>
					)}
					<details>
						<summary className="cursor-pointer text-xs text-primary">
							Details
						</summary>
						<pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-text-secondary">
							{JSON.stringify(h.changes, null, 2)}
						</pre>
					</details>
				</li>
			))}
		</ul>
	);
}
