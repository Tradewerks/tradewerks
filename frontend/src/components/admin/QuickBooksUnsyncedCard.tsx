import { Loader2 } from "lucide-react";
import { useQBSyncNowMutation, useQBUnsyncedQuery } from "../../hooks/useQuickbooks";
import ModuleNotice from "../entitlements/ModuleNotice";

const KIND = {
	invoice: "Invoice",
	purchase: "Purchase",
	field_purchase: "Field purchase",
	// The label reads "payment on INV-…".
	payment: "Invoice",
} as const;

export default function QuickBooksUnsyncedCard({ connected }: { connected: boolean }) {
	const { data: docs = [] } = useQBUnsyncedQuery(connected);
	const sync = useQBSyncNowMutation();
	if (!connected || (docs.length === 0 && !sync.data)) return null;
	const failed = sync.data?.failed ?? [];
	return (
		<ModuleNotice
			title={
				<>
					{docs.length} {docs.length === 1 ? "document" : "documents"} not synced
				</>
			}
			action={
				<button
					type="button"
					disabled={sync.isPending || docs.length === 0}
					onClick={() => sync.mutate()}
					className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50"
				>
					{sync.isPending && <Loader2 size={12} className="animate-spin" />}
					Sync now
				</button>
			}
		>
			{(failed.length > 0 || docs.length > 0) && (
				<>
					{failed.length > 0 && (
						<div role="alert" className="text-xs text-error-text">
							{failed.length} could not be synced:
							<ul className="mt-1 space-y-1">
								{failed.map((f) => (
									<li key={`${f.type}:${f.id}`}>
										<span className="font-medium">{f.label}</span>
										{" · "}
										{f.message}
									</li>
								))}
							</ul>
						</div>
					)}
					{docs.length > 0 && (
						<details className={failed.length > 0 ? "mt-2" : undefined}>
							<summary className="cursor-pointer text-xs text-text-secondary">
								Show documents
							</summary>
							<ul className="mt-2 space-y-1">
								{docs.map((d) => (
									<li
										key={`${d.type}:${d.id}`}
										className="text-xs text-text-secondary"
									>
										{KIND[d.type]} {d.label}
										{d.status === "failed" && (
											<span className="text-error-text">
												{" "}
												· last sync failed
											</span>
										)}
									</li>
								))}
							</ul>
						</details>
					)}
				</>
			)}
		</ModuleNotice>
	);
}
