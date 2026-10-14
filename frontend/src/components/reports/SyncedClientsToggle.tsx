import { Link2 } from "lucide-react";

export default function SyncedClientsToggle({
	active,
	onToggle,
	mappedCount,
}: {
	active: boolean;
	onToggle: () => void;
	mappedCount: number;
}) {
	const disabled = mappedCount === 0;

	return (
		<button
			onClick={onToggle}
			disabled={disabled}
			aria-pressed={active}
			title={
				disabled
					? "No clients are linked to QuickBooks yet"
					: active
						? "Showing only clients linked to QuickBooks"
						: "Show only clients linked to QuickBooks"
			}
			className={`flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium transition-colors border ${
				disabled
					? "border-border text-text-faint cursor-not-allowed"
					: active
						? "bg-primary-bg border-primary text-primary-text"
						: "border-border text-text-tertiary hover:bg-surface hover:text-text-primary"
			}`}
		>
			<Link2 size={15} />
			Synced clients only
			{mappedCount > 0 && (
				<span
					className={`text-xs font-semibold tabular-nums ${
						active ? "text-primary-text" : "text-text-faint"
					}`}
				>
					{mappedCount}
				</span>
			)}
		</button>
	);
}
