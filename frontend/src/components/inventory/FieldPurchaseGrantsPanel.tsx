import { useMemo, useState } from "react";
import { AlertTriangle, Pencil, ShieldCheck, ShieldX } from "lucide-react";
import {
	useFieldPurchaseGrants,
	useRevokeFieldPurchaseGrant,
	useUpsertFieldPurchaseGrant,
} from "../../hooks/useFieldPurchases";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";
import { useToast } from "../ui/useToast";
import { errorMessage } from "../../util/util";
import EmptyState from "../ui/EmptyState";
import { ActionButton, Chip } from "../fieldPurchases/fieldPurchaseUi";
import { COL_LABEL, FOCUS_RING, money } from "../fieldPurchases/fieldPurchaseFormat";
import type { FieldPurchaseGrant } from "../../types/fieldPurchases";

const FIELD = `h-9 w-full rounded-md border border-border bg-base px-2 text-sm text-text-primary ${FOCUS_RING}`;

/**
 * Who may buy in the field, and up to what. Authority is per technician and
 * revocable rather than a role permission: the role decides who reaches the flow,
 * these numbers bound the money. Revoking never deletes - a purchase in flight when
 * authority is pulled still has to reconcile - and every change lands in the trail.
 */
export default function FieldPurchaseGrantsPanel() {
	const { data: grants = [], isLoading, isError } = useFieldPurchaseGrants();
	const {
		data: technicians = [],
		isLoading: techsLoading,
		isError: techsFailed,
	} = useActiveTechniciansQuery();
	const upsert = useUpsertFieldPurchaseGrant();
	const revoke = useRevokeFieldPurchaseGrant();
	const toast = useToast();

	const [techId, setTechId] = useState("");
	const [perTxn, setPerTxn] = useState("250");
	const [daily, setDaily] = useState("");
	const [weekly, setWeekly] = useState("");
	const [perJob, setPerJob] = useState("");
	// One editor handles both granting and editing a ceiling, so changing a
	// number is a single update rather than a revoke-then-restore that would
	// briefly put the OLD numbers back in effect.
	const [editing, setEditing] = useState<FieldPurchaseGrant | null>(null);

	const amount = (v: string | null) => (v == null ? "" : String(Number(v)));

	function startEdit(grant: FieldPurchaseGrant) {
		setEditing(grant);
		setTechId(grant.technician_id);
		setPerTxn(amount(grant.per_transaction_limit));
		setDaily(amount(grant.daily_limit));
		setWeekly(amount(grant.weekly_limit));
		setPerJob(amount(grant.per_job_limit));
	}

	function cancelEdit() {
		setEditing(null);
		setTechId("");
		setPerTxn("250");
		setDaily("");
		setWeekly("");
		setPerJob("");
	}

	// Only techs without a live grant: an existing one is edited from its row, so
	// offering it here too would be two doors to the same record.
	const unauthorized = useMemo(() => {
		const held = new Set(grants.filter((g) => g.is_active).map((g) => g.technician_id));
		return technicians.filter((t) => !held.has(t.id));
	}, [grants, technicians]);

	/**
	 * Restoring a revoked grant reinstates the ceilings it had, not whatever is
	 * typed in the form on the left — those belong to the technician being added,
	 * and applying them here silently rewrote somebody else's limits.
	 */
	async function save(id?: string, restoring?: FieldPurchaseGrant) {
		const target = id ?? techId;
		if (!target) return;
		try {
			await upsert.mutateAsync(
				restoring
					? {
							technician_id: target,
							per_transaction_limit: Number(restoring.per_transaction_limit),
							daily_limit: restoring.daily_limit ? Number(restoring.daily_limit) : null,
							weekly_limit: restoring.weekly_limit ? Number(restoring.weekly_limit) : null,
							per_job_limit: restoring.per_job_limit ? Number(restoring.per_job_limit) : null,
						}
					: {
							technician_id: target,
							per_transaction_limit: Number(perTxn),
							daily_limit: daily ? Number(daily) : null,
							weekly_limit: weekly ? Number(weekly) : null,
							per_job_limit: perJob ? Number(perJob) : null,
						}
			);
			cancelEdit();
			toast.success("Authorization saved");
		} catch (err) {
			toast.error(errorMessage(err, "Failed to save authorization"));
		}
	}

	async function onRevoke(id: string) {
		try {
			await revoke.mutateAsync({ id });
			toast.success("Authorization revoked");
		} catch (err) {
			toast.error(errorMessage(err, "Failed to revoke"));
		}
	}

	return (
		<div className="flex min-h-full flex-col lg:flex-row">
			<section className="border-b border-border px-4 py-3 lg:w-[320px] lg:flex-shrink-0 lg:border-b-0 lg:border-r">
				<h2 className="mb-3 text-sm font-semibold text-text-primary">
					{editing ? `Change ${editing.technician.name}'s limits` : "Authorize a technician"}
				</h2>
				<label className="block">
					<span className={`mb-1 block ${COL_LABEL}`}>Technician</span>
					{editing ? (
						<p className={`${FIELD} leading-9`}>{editing.technician.name}</p>
					) : (
						<select
							value={techId}
							disabled={techsLoading || techsFailed}
							onChange={(e) => setTechId(e.target.value)}
							className={FIELD}
						>
							<option value="">
								{techsFailed
									? "Could not load technicians"
									: techsLoading
										? "Loading…"
										: "Choose…"}
							</option>
							{unauthorized.map((t) => (
								<option key={t.id} value={t.id}>
									{t.name}
								</option>
							))}
						</select>
					)}
					{/* An empty roster and a failed request looked identical, and the
					    empty one reads as "everyone is already authorized". */}
					{techsFailed && !editing && (
						<span className="mt-1 block text-xs text-warning-text">
							The request failed, so this is not the roster. Refresh the page to
							try again.
						</span>
					)}
					{!techsFailed && !techsLoading && !editing && unauthorized.length === 0 && (
						<span className="mt-1 block text-xs text-text-muted">
							Every technician already has an active authorization — edit one from
							its row.
						</span>
					)}
				</label>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<label>
						<span className={`mb-1 block ${COL_LABEL}`}>Per purchase</span>
						<input
							value={perTxn}
							inputMode="decimal"
							onChange={(e) => setPerTxn(e.target.value)}
							className={`${FIELD} tabular-nums`}
						/>
					</label>
					<label>
						<span className={`mb-1 block ${COL_LABEL}`}>Per day</span>
						<input
							value={daily}
							inputMode="decimal"
							placeholder="No cap"
							onChange={(e) => setDaily(e.target.value)}
							className={`${FIELD} tabular-nums placeholder:text-text-muted`}
						/>
					</label>
					<label>
						<span className={`mb-1 block ${COL_LABEL}`}>Per week</span>
						<input
							value={weekly}
							inputMode="decimal"
							placeholder="No cap"
							onChange={(e) => setWeekly(e.target.value)}
							className={`${FIELD} tabular-nums placeholder:text-text-muted`}
						/>
					</label>
					<label>
						<span className={`mb-1 block ${COL_LABEL}`}>Per job</span>
						<input
							value={perJob}
							inputMode="decimal"
							placeholder="No cap"
							onChange={(e) => setPerJob(e.target.value)}
							className={`${FIELD} tabular-nums placeholder:text-text-muted`}
						/>
					</label>
				</div>
				<p className="mt-2 text-xs text-text-muted">
					A purchase over any cap is not refused — it needs a dispatcher to pre-approve it before
					the technician buys.
				</p>
				<div className="mt-3 flex gap-2">
					<ActionButton
						variant="primary"
						className="flex-1"
						icon={<ShieldCheck aria-hidden size={14} />}
						disabled={!techId || upsert.isPending || !Number(perTxn)}
						onClick={() => void save()}
					>
						{editing ? "Save limits" : "Authorize"}
					</ActionButton>
					{editing && (
						<ActionButton variant="ghost" onClick={cancelEdit}>
							Cancel
						</ActionButton>
					)}
				</div>
			</section>

			<section className="min-w-0 flex-1">
				{isLoading ? (
					<p className="px-4 py-6 text-sm text-text-muted">Loading…</p>
				) : isError ? (
					// Before this the failed request fell through to the empty state,
					// which told a dispatcher that nobody could spend — and the fix it
					// invited was re-granting authority that already existed.
					<EmptyState
						title="Could not load the authorizations"
						description="The request failed, so this is not a statement about who is authorized. Refresh the page to try again."
						icon={<AlertTriangle aria-hidden size={28} />}
					/>
				) : grants.length === 0 ? (
					<EmptyState
						title="Nobody is authorized to buy in the field yet"
						description="Authority is per technician and revocable — the role only decides who can reach the flow."
						icon={<ShieldCheck aria-hidden size={28} />}
					/>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border bg-surface">
									<th className={`${COL_LABEL} px-4 py-2 text-left`}>Technician</th>
									<th className={`${COL_LABEL} px-2 py-2 text-right`}>Per purchase</th>
									<th className={`${COL_LABEL} px-2 py-2 text-right`}>Per day</th>
									<th className={`${COL_LABEL} px-2 py-2 text-right`}>Per week</th>
									<th className={`${COL_LABEL} px-2 py-2 text-right`}>Per job</th>
									<th className={`${COL_LABEL} px-4 py-2 text-right`}>Actions</th>
								</tr>
							</thead>
							<tbody>
								{grants.map((g) => (
									<tr key={g.id} className="border-b border-border-subtle last:border-b-0">
										<td className="px-4 py-2">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate font-medium text-text-primary">
													{g.technician.name}
												</span>
												<Chip tone={g.is_active ? "success" : "neutral"}>
													{g.is_active ? "Active" : "Revoked"}
												</Chip>
											</span>
											{!g.is_active && (
												<span className="block text-xs text-text-muted">
													Revoked
													{g.revoked_at ? ` ${new Date(g.revoked_at).toLocaleDateString()}` : ""}
													{g.revoked_by ? ` by ${g.revoked_by.name}` : ""}
												</span>
											)}
										</td>
										<td className="px-2 py-2 text-right tabular-nums text-text-secondary">
											{money(g.per_transaction_limit)}
										</td>
										<td className="px-2 py-2 text-right tabular-nums text-text-muted">
											{g.daily_limit ? money(g.daily_limit) : "—"}
										</td>
										<td className="px-2 py-2 text-right tabular-nums text-text-muted">
											{g.weekly_limit ? money(g.weekly_limit) : "—"}
										</td>
										<td className="px-2 py-2 text-right tabular-nums text-text-muted">
											{g.per_job_limit ? money(g.per_job_limit) : "—"}
										</td>
										<td className="px-4 py-2 text-right">
											{g.is_active ? (
												<span className="inline-flex gap-1.5">
													<ActionButton
														variant="secondary"
														icon={<Pencil aria-hidden size={13} />}
														onClick={() => startEdit(g)}
													>
														Edit
													</ActionButton>
													<ActionButton
														variant="danger"
														icon={<ShieldX aria-hidden size={13} />}
														disabled={revoke.isPending}
														onClick={() => void onRevoke(g.id)}
													>
														Revoke
													</ActionButton>
												</span>
											) : (
												<ActionButton
													variant="secondary"
													icon={<ShieldCheck aria-hidden size={13} />}
													disabled={upsert.isPending}
													onClick={() => void save(g.technician_id, g)}
												>
													Restore
												</ActionButton>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
