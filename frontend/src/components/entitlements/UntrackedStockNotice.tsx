import { Link } from "react-router-dom";
import type { StockNoticeModule } from "../../api/moduleNotices";
import {
	useDismissUntrackedStockNotice,
	useUntrackedStockNotice,
} from "../../hooks/useModuleNotices";
import { usePermission } from "../../hooks/usePermission";
import ModuleNotice from "./ModuleNotice";

const day = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

export default function UntrackedStockNotice({
	module,
	className = "mb-4",
}: {
	module: StockNoticeModule;
	className?: string;
}) {
	const { data: notice } = useUntrackedStockNotice(module);
	const dismiss = useDismissUntrackedStockNotice(module);
	const canDismiss = usePermission("manage_inventory");
	if (!notice) return null;
	const what = module === "inventory" ? "Stock" : "Vehicle stock";
	return (
		<ModuleNotice
			className={className}
			title={
				<>
					{what} was not tracked from {day(notice.off)} to {day(notice.on)}. Counts may
					be wrong until the affected items are recounted.
				</>
			}
			action={
				canDismiss ? (
					<button
						type="button"
						disabled={dismiss.isPending}
						onClick={() => dismiss.mutate(notice.on)}
						className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
					>
						Dismiss
					</button>
				) : null
			}
		>
			{notice.visits.length > 0 && (
				<details>
					<summary className="cursor-pointer text-xs text-text-secondary">
						{notice.visits.length} completed{" "}
						{notice.visits.length === 1 ? "visit" : "visits"} used stocked parts in
						that time
					</summary>
					<ul className="mt-2 space-y-1">
						{notice.visits.map((v) => (
							<li key={v.id} className="text-xs">
								<Link
									to={`/dispatch/jobs/${v.job_id}/visits/${v.id}`}
									className="text-primary hover:underline"
								>
									{v.name ?? "Visit"}
								</Link>
								<span className="text-text-muted">
									{" "}
									· completed {day(v.completed_at)}
								</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</ModuleNotice>
	);
}
