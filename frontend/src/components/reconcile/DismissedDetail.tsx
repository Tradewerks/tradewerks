import { RotateCcw } from "lucide-react";
import LineTable from "./LineTable";
import { ActionError } from "./reconcileUi";
import { COL_LABEL, shortDate } from "./reconcileFormat";
import { useRestoreUnmappedMutation } from "../../hooks/useInventory";
import { useToast } from "../ui/useToast";
import type { ReconcileDismissedRow } from "../../api/inventory";

/**
 * A past decision, and what it is still costing. Dismissal is the lazy way out of
 * the queue, so it stays attributed and reversible - and the line table is here on
 * purpose: seeing an "intentional" name quietly carrying thousands in billing is
 * what makes anyone revisit the call.
 */
export default function DismissedDetail({
	row,
	onSettled,
}: {
	row: ReconcileDismissedRow;
	onSettled: () => void;
}) {
	const toast = useToast();
	const restore = useRestoreUnmappedMutation();

	async function onReopen() {
		try {
			await restore.mutateAsync({ name: row.folded_name });
			toast.success(`"${row.folded_name}" is back in the queue.`);
			onSettled();
		} catch {
			// Surfaced through restore.error.
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="border-b border-border px-3 py-2.5">
				<h2
					className="truncate text-base font-semibold text-text-primary"
					title={row.folded_name}
				>
					{row.folded_name}
				</h2>
				<p className="mt-0.5 text-xs text-text-muted">
					Marked intentional by{" "}
					{row.decided_by
						? row.decided_by.name
						: "someone no longer on the team"}{" "}
					· {shortDate(row.decided_at)}
				</p>
			</header>

			<div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
				<section className="space-y-2 p-3">
					<h3 className={COL_LABEL}>Reason given</h3>
					<p className="text-sm text-text-secondary">
						{row.reason || (
							<span className="text-text-muted">
								None recorded. The decision stands,
								but nobody said why.
							</span>
						)}
					</p>
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<button
							type="button"
							disabled={restore.isPending}
							onClick={() => void onReopen()}
							className="inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-base px-3 text-xs font-medium text-text-primary transition-colors duration-150 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
						>
							<RotateCcw size={12} />
							Reopen
						</button>
						<span className="text-[11px] text-text-muted">
							Puts the name back in the queue and back
							into coverage.
						</span>
					</div>
					<ActionError error={restore.error} />
				</section>

				<LineTable foldedName={row.folded_name} />
			</div>
		</div>
	);
}
