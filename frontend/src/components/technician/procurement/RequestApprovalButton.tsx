import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShieldQuestion } from "lucide-react";
import {
	useCreateFieldPurchase,
	useMyPurchaseAuthority,
	usePurchaseLimitBreaches,
	useRequestPreauth,
} from "../../../hooks/useFieldPurchases";
import { useMyJobsQuery } from "../../../hooks/useJobs";
import { useDialogA11y } from "../../../hooks/useDialogA11y";
import { usePermission } from "../../../hooks/usePermission";
import LimitBreachNotice from "./LimitBreachNotice";
import { errorMessage } from "../../../util/util";
import type { MyJobOption } from "../../../api/jobs";

const jobLabel = (j: MyJobOption) => j.job_name || `Job ${j.job_number ?? ""}`.trim();

interface JobRow {
	job_id: string;
	label: string;
}

/**
 * Spec Flow B: the part that costs more than the technician will front, asked
 * before the counter rather than after.
 *
 * Two writes - a draft, then the pre-authorization against it - because the server
 * only accepts `requestPreauth` on a purchase that exists. Doing only the first is
 * what left this path dead: a draft with an estimate and no receipt reads as
 * "photograph the receipt first", which is what this technician cannot do.
 */
export default function RequestApprovalButton({
	preselectedJobId,
	autoOpen = false,
}: {
	preselectedJobId?: string | null;
	autoOpen?: boolean;
}) {
	const [open, setOpen] = useState(autoOpen);
	// The purchases page is already behind both of these, so this is a no-op
	// there. It matters on the visit, which is not — and a technician with no
	// ceiling should not be offered a form the server will refuse. Silent rather
	// than explanatory: StartPurchaseButton sits beside this one and already says
	// why, and two cards saying the same thing is worse than one.
	const canRequest = usePermission("request_field_purchase");
	const { data: authority } = useMyPurchaseAuthority(canRequest);
	if (!canRequest || (authority && !authority.grant?.is_active)) return null;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-base px-4 py-3 text-left transition-colors hover:border-border-strong"
			>
				<ShieldQuestion
					aria-hidden
					size={16}
					className="flex-shrink-0 text-text-muted"
				/>
				<span className="min-w-0">
					<span className="block text-sm font-medium text-text-primary">
						Request approval before buying
					</span>
					<span className="block text-xs text-text-muted">
						Not paid yet. Send an estimate — dispatch answers before
						you spend your own money.
					</span>
				</span>
			</button>

			{open && (
				<ApprovalSheet
					preselectedJobId={preselectedJobId ?? ""}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function ApprovalSheet({
	preselectedJobId,
	onClose,
}: {
	preselectedJobId: string;
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const { data: myJobs = [], isLoading: jobsLoading, isError: jobsFailed } = useMyJobsQuery();
	const create = useCreateFieldPurchase();
	const preauth = useRequestPreauth();

	const [jobId, setJobId] = useState(preselectedJobId);
	const [amount, setAmount] = useState("");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	// The draft survives a failed pre-authorization, so a retry lands on the row
	// that already exists rather than leaving a trail of orphans behind it.
	const startedRef = useRef<string | null>(null);

	const dialogProps = useDialogA11y<HTMLDivElement>(() => {
		if (!busy) onClose();
	});

	const estimate = Number(amount) || 0;
	const chosen = myJobs.find((j) => j.job_id === jobId) ?? null;

	// A job named by the link but absent from the list — a visit that was
	// cancelled, say — still has to be pickable, or the link leads nowhere.
	const rows: JobRow[] = myJobs.map((j) => ({ job_id: j.job_id, label: jobLabel(j) }));
	const options =
		preselectedJobId && !myJobs.some((j) => j.job_id === preselectedJobId)
			? [{ job_id: preselectedJobId, label: "This job" }, ...rows]
			: rows;

	// Asked of the server: the daily, weekly and per-job ceilings depend on what
	// has already been spent, which this screen cannot know.
	const breaches = usePurchaseLimitBreaches(estimate, jobId || undefined);

	function pickJob(id: string) {
		// A started draft carries the old job's allocation, so it cannot be reused.
		if (id !== jobId) startedRef.current = null;
		setJobId(id);
	}

	async function send() {
		if (!jobId || estimate <= 0) return;
		setBusy(true);
		setFailure(null);
		try {
			const id =
				startedRef.current ??
				(
					await create.mutateAsync({
						reason: reason.trim() || null,
						estimated_amount: estimate,
						allocations: [
							{
								job_id: jobId,
								// From the job's own row, so it is the visit that job
								// actually has rather than whatever a URL claimed.
								...(chosen
									? {
											job_visit_id:
												chosen.visit_id,
										}
									: {}),
							},
						],
					})
				).id;
			startedRef.current = id;
			await preauth.mutateAsync({
				id,
				estimatedAmount: estimate,
				reason: reason.trim() || null,
			});
			navigate(`/technician/purchases/${id}`);
		} catch (err) {
			setFailure(errorMessage(err, "Could not send the request"));
		} finally {
			setBusy(false);
		}
	}

	// z-[60], not z-50: the technician layout's bottom nav is fixed at z-50 and
	// later in the DOM, so a matching z-index leaves it painting over this
	// sheet's own buttons.
	return (
		<div
			{...dialogProps}
			aria-label="Request approval before buying"
			className="fixed inset-0 z-[60] flex items-end justify-center bg-overlay lg:items-center"
		>
			{/* Sheet on phones, centered panel on desktop: full width past lg stretched
			    this form edge to edge. lg:max-w-lg is TechPage's "narrow" tier, which is
			    what a single-column form reads as. */}
			<div className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-canvas p-4 lg:max-w-lg lg:rounded-2xl lg:border">
				<h2 className="text-sm font-semibold text-text-primary">
					Request approval before buying
				</h2>
				<p className="mt-1 text-xs text-text-muted">
					Dispatch answers before you pay, so you are not fronting
					money you may not get back.
				</p>

				{failure && (
					<p className="mt-2 text-xs text-warning-text">{failure}</p>
				)}

				<div className="mt-3">
					<span className="mb-1 block text-xs text-text-muted">
						Job this is for
					</span>
					{jobsLoading ? (
						<p className="text-sm text-text-muted">
							Loading your jobs…
						</p>
					) : jobsFailed ? (
						// Distinct from the empty case on purpose: "no jobs assigned"
						// reads as dispatch's doing, and sends the technician to argue
						// with the wrong person when the request simply failed.
						<p className="text-sm text-warning-text">
							Could not load your jobs. Check your signal
							and reopen this.
						</p>
					) : options.length === 0 ? (
						<p className="text-sm text-text-muted">
							You have no jobs assigned right now —
							dispatch has to attach this one.
						</p>
					) : (
						<ul className="space-y-2">
							{options.map((o) => (
								<li key={o.job_id}>
									<button
										type="button"
										aria-pressed={
											jobId ===
											o.job_id
										}
										onClick={() =>
											pickJob(
												o.job_id
											)
										}
										className={`flex min-h-11 w-full items-center rounded-lg border px-3 py-2.5 text-left text-sm text-text-primary transition-colors ${
											jobId ===
											o.job_id
												? "border-primary-border bg-primary-bg"
												: "border-border bg-base hover:bg-surface"
										}`}
									>
										<span className="min-w-0 truncate">
											{o.label}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				<label className="mt-3 block">
					<span className="mb-1 block text-xs text-text-muted">
						Estimated cost
					</span>
					<input
						value={amount}
						inputMode="decimal"
						onChange={(e) => setAmount(e.target.value)}
						placeholder="0.00"
						className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm tabular-nums text-text-primary"
					/>
				</label>

				<label className="mt-3 block">
					<span className="mb-1 block text-xs text-text-muted">
						Reason (optional)
					</span>
					<input
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Part not on the truck, job is down"
						className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary placeholder:text-text-muted"
					/>
				</label>

				{breaches && breaches.length > 0 && (
					<div className="mt-3">
						<LimitBreachNotice
							breaches={breaches}
							amount={estimate}
						/>
					</div>
				)}

				<div className="mt-4 flex gap-2">
					<button
						type="button"
						disabled={busy}
						onClick={onClose}
						className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-text-secondary hover:enabled:bg-surface-raised disabled:opacity-40"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={!jobId || estimate <= 0 || busy}
						onClick={() => void send()}
						className="inline-flex h-11 flex-[2] items-center justify-center gap-2 rounded-md bg-primary-hover text-sm font-semibold text-on-primary hover:enabled:bg-primary-active disabled:opacity-40"
					>
						{busy && (
							<Loader2
								aria-hidden
								size={14}
								className="animate-spin"
							/>
						)}
						Send for approval
					</button>
				</div>
			</div>
		</div>
	);
}
