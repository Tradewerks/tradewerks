import { Link } from "react-router-dom";
import Card from "../../ui/Card";
import ActivityPanel from "../../detail/ActivityPanel";
import ChangeHistory from "../../activity/ChangeHistory";
import { Chip } from "../../fieldPurchases/fieldPurchaseUi";
import { purchaseHref } from "../../fieldPurchases/queueFilters";
import { useFieldPurchases } from "../../../hooks/useFieldPurchases";
import { usePermission } from "../../../hooks/usePermission";
import {
	FIELD_PURCHASE_STATUS_LABELS,
	isPrePurchase,
	type FieldPurchase,
} from "../../../types/fieldPurchases";
import type { Technician } from "../../../types/technicians";

const SHOWN = 5;

// The dispatcher queue row's naming rule (PurchaseQueue QueueRow), minus the
// technician it leads with — this page already is that technician. Before the
// counter there is no vendor to have recorded, so the job names the request.
function purchaseName(p: FieldPurchase): string {
	if (!isPrePurchase(p.status)) return p.vendor_name || "Vendor not recorded";
	const job = p.allocations[0]?.job;
	if (p.allocations.length > 1) return `${p.allocations.length} jobs`;
	return job?.job_number ? `Job #${job.job_number}` : job?.name || "No job attached";
}

function RecentPurchases({ techId }: { techId: string }) {
	// Over-fetched because drafts are dropped below: a technician holding a few
	// unfinished sheets would otherwise push every real purchase off the list.
	const { data, isLoading, isError } = useFieldPurchases({
		technician_id: techId,
		limit: SHOWN * 2,
		sort: "newest",
	});
	if (isLoading) return <div className="h-24 animate-pulse rounded-lg bg-surface" />;
	if (isError)
		return <p className="text-sm text-error-text">Couldn't load field purchases.</p>;
	// A draft has no receipt behind it and no dispatch action, and no queue rail
	// lists one, so its link would open a view with nothing selected.
	const rows = (data ?? []).filter((p) => p.status !== "draft").slice(0, SHOWN);
	if (!rows.length)
		return <p className="text-sm text-text-muted">No submitted field purchases yet.</p>;
	return (
		// -mx-2/px-2: same bleed as the Schedule rows, so the hover band has room.
		<ul className="-mx-2 divide-y divide-border-subtle">
			{rows.map((p) => (
				<li key={p.id}>
					<Link
						to={purchaseHref(p.id, p.status)}
						className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors duration-150 ease-out hover:bg-surface-raised focus-visible:bg-surface-raised"
					>
						<span className="min-w-0 truncate">
							{purchaseName(p)}
							{p.kind === "refund" && (
								<span className="ml-1.5 text-xs text-text-muted">
									refund
								</span>
							)}
						</span>
						<Chip>
							{FIELD_PURCHASE_STATUS_LABELS[p.status]}
						</Chip>
					</Link>
				</li>
			))}
		</ul>
	);
}

/**
 * §10 reserves the rail for a write surface. Technicians have no notes entity,
 * and an empty third column is the underfill §10 exists to prevent, so the rail
 * carries the technician's most recent operational record instead.
 */
export default function TechnicianActivityTab({ technician }: { technician: Technician }) {
	const canSeePurchases = usePermission("view_field_purchases");
	return (
		<ActivityPanel
			lifecycle={null}
			history={
				<ChangeHistory
					scope={{
						kind: "actor",
						type: "technician",
						id: technician.id,
					}}
				/>
			}
			notes={
				<Card title="Recent Field Purchases">
					{canSeePurchases ? (
						<RecentPurchases techId={technician.id} />
					) : (
						<p className="text-sm text-text-muted">
							Needs the View Field Purchases permission.
						</p>
					)}
				</Card>
			}
		/>
	);
}
