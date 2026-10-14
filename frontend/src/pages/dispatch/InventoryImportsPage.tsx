import { FilePlus2, History } from "lucide-react";
import { Link } from "react-router-dom";
import { useInventoryImports } from "../../hooks/useInventoryImports";
import { usePermission } from "../../hooks/usePermission";

const statusLabel = (status: string) => status.replace(/_/g, " ");

export default function InventoryImportsPage() {
	const query = useInventoryImports();
	const canManage = usePermission("manage_inventory");
	return (
		<div className="mx-auto max-w-6xl space-y-6 p-6">
			<div className="flex items-center justify-between">
				<div><h1 className="text-2xl font-semibold text-text-primary">Inventory imports</h1><p className="mt-1 text-sm text-muted">Persistent drafts, review decisions, commits, and undo history.</p></div>
				{canManage && <Link to="/dispatch/inventory/imports/new" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary"><FilePlus2 size={15} /> New import</Link>}
			</div>
			<div className="overflow-hidden rounded-xl border border-border bg-base">
				<div className="grid grid-cols-[1fr_150px_100px_170px] gap-4 border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted"><span>Sources</span><span>Status</span><span>Rows</span><span>Created</span></div>
				{query.isLoading && <p className="p-8 text-center text-sm text-muted">Loading imports…</p>}
				{query.data?.items.map((record) => (
					<Link key={record.id} to={`/dispatch/inventory/imports/${record.id}`} className="grid grid-cols-[1fr_150px_100px_170px] gap-4 border-b border-border px-4 py-4 text-sm last:border-0 hover:bg-canvas">
						<div className="flex min-w-0 items-center gap-2"><History size={15} className="shrink-0 text-link" /><span className="truncate text-text-primary">{record.sources.map((source) => source.original_filename).join(", ") || "Import draft"}</span></div>
						<span className="capitalize text-secondary">{statusLabel(record.status)}</span>
						<span className="text-secondary">{record.total_count}</span>
						<span className="text-muted">{new Date(record.created_at).toLocaleString()}</span>
					</Link>
				))}
				{query.data?.items.length === 0 && <p className="p-10 text-center text-sm text-muted">No inventory imports yet.</p>}
			</div>
	</div>
	);
}
