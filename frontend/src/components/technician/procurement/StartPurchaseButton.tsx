import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Receipt, ShieldOff } from "lucide-react";
import {
	useCreateFieldPurchase,
	useDeleteFieldPurchase,
	useMyPurchaseAuthority,
	useUploadReceipt,
} from "../../../hooks/useFieldPurchases";
import { useDialogA11y } from "../../../hooks/useDialogA11y";
import { useMyJobsQuery } from "../../../hooks/useJobs";
import { usePermission } from "../../../hooks/usePermission";
import { errorMessage } from "../../../util/util";
import { captureFrom } from "./receiptCapture";
import ReceiptScanner from "./ReceiptScanner";
import AskForAccessButton from "./AskForAccessButton";

/** The job a receipt is bought for, and the visit its charge lands on. */
export interface PurchaseJob {
	id: string;
	visitId: string | null;
}

interface Props {
	/**
	 * Known when the flow starts on a visit. Null everywhere else, which is what
	 * makes the job question a step instead of a prerequisite.
	 */
	job: PurchaseJob | null;
	/** Where a `receive` line goes by default — the truck the technician is at. */
	vehicleId?: string | null;
	label?: string;
	/** Second line, for the surfaces where this sits beside a competing choice. */
	hint?: string;
}

/**
 * Buying a part, camera first, from wherever the technician is standing. The
 * amount, vendor and date are all printed on the thing about to be photographed, so
 * asking for any of them first is asking a tech at a counter to type what the camera
 * is about to read. The job, when not already known, is asked once after the shot.
 */
export default function StartPurchaseButton({ job, vehicleId, label, hint }: Props) {
	const canRequest = usePermission("request_field_purchase");
	const navigate = useNavigate();
	const [scanning, setScanning] = useState(false);
	// The shot, waiting on a job to attach it to. Held rather than uploaded so a
	// technician who backs out of the job question leaves no headless draft.
	const [pending, setPending] = useState<File | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	// The job id being attached, not a bare flag: a bare flag spun the loader on
	// every row in the list instead of the one that was tapped.
	const [busyJobId, setBusyJobId] = useState<string | null>(null);
	// A purchase survives a failed upload, so a retry attaches to the row that
	// already exists rather than leaving a trail of empty drafts behind it — but
	// only for the job it was created for: the allocation is what bills, so a
	// reused row would put this receipt on the previous job's customer.
	const startedRef = useRef<{ id: string; jobId: string } | null>(null);

	const { data: authority, isLoading: authorityLoading } =
		useMyPurchaseAuthority(canRequest);
	const {
		data: myJobs = [],
		isLoading: jobsLoading,
		isError: jobsFailed,
	} = useMyJobsQuery(canRequest && !job);
	const create = useCreateFieldPurchase();
	const upload = useUploadReceipt();
	const remove = useDeleteFieldPurchase();

	/** Create, attach, open. The one path both entry points end on. */
	async function attach(file: File, to: PurchaseJob) {
		const capture = await captureFrom(file);
		const held = startedRef.current;
		// The held row named another job, so it is not this receipt's row. Dropped
		// and cleaned up rather than left behind: an empty draft shows on the
		// technician's own list and on dispatch's, reading as an abandoned purchase.
		if (held && held.jobId !== to.id) {
			startedRef.current = null;
			// Fire and forget. A technician standing at a counter waits on the retry,
			// never on tidying up the row they walked away from.
			void remove.mutateAsync(held.id).catch(() => undefined);
		}
		// Which job, not how much: the share follows from the lines, and there are
		// none until the receipt is read.
		const id =
			startedRef.current?.id ??
			(
				await create.mutateAsync({
					allocations: [{ job_id: to.id, job_visit_id: to.visitId }],
				})
			).id;
		startedRef.current = { id, jobId: to.id };
		await upload.mutateAsync({ id, capture });
		navigate(`/technician/purchases/${id}${vehicleId ? `?vehicleId=${vehicleId}` : ""}`);
	}

	// Throws on purpose when the job is known: the scanner keeps the photo and
	// shows the reason, so a failed upload costs one tap rather than another walk
	// back to the counter.
	async function onAccept(file: File) {
		if (job) return attach(file, job);
		setPending(file);
		setScanning(false);
	}

	async function onPickJob(jobId: string) {
		const picked = myJobs.find((j) => j.job_id === jobId);
		if (!picked || !pending) return;
		setBusyJobId(jobId);
		setFailure(null);
		try {
			await attach(pending, { id: picked.job_id, visitId: picked.visit_id ?? null });
		} catch (err) {
			// The photo is still held, so the way out is picking again rather than
			// photographing the receipt a second time.
			setFailure(errorMessage(err, "Could not attach the receipt"));
		} finally {
			setBusyJobId(null);
		}
	}

	if (!canRequest) return null;

	// Authority is per-technician and revocable, so holding the permission is not
	// holding a ceiling. A technician who finds that out at a counter needs a way
	// forward from where they were stopped, not a page telling them no.
	if (authority && !authority.grant?.is_active) {
		return (
			<div className="flex items-start gap-3 rounded-xl border border-border bg-base px-4 py-3">
				<ShieldOff aria-hidden size={16} className="mt-0.5 flex-shrink-0 text-text-muted" />
				<div className="min-w-0">
					<p className="text-sm font-medium text-text-primary">
						Field purchasing is not enabled for you
					</p>
					<div className="mt-1">
						<AskForAccessButton />
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<button
				type="button"
				// Disabled, not hidden, while the grant loads: tapping through to the
				// camera before the ceiling is known is a long walk to a refusal, and a
				// button that flashes into existence is worse than a dim one.
				disabled={authorityLoading}
				aria-busy={authorityLoading}
				onClick={() => setScanning(true)}
				className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-base px-4 py-3 text-left transition-colors hover:enabled:border-border-strong disabled:opacity-50"
			>
				<Receipt aria-hidden size={16} className="flex-shrink-0 text-text-muted" />
				<span className="min-w-0">
					<span className="block text-sm font-medium text-text-primary">
						{label ?? "Record a field purchase"}
					</span>
					{hint && <span className="block text-xs text-text-muted">{hint}</span>}
				</span>
			</button>

			{scanning && (
				<ReceiptScanner
					title="Photograph receipt"
					confirmLabel={job ? "Start field purchase" : "Use photo"}
					onAccept={onAccept}
					onClose={() => setScanning(false)}
				/>
			)}

			{pending && (
				<JobChooser
					jobs={myJobs}
					jobsLoading={jobsLoading}
					jobsFailed={jobsFailed}
					busyJobId={busyJobId}
					failure={failure}
					onPick={(id) => void onPickJob(id)}
					onRetake={() => {
						setPending(null);
						setFailure(null);
						setScanning(true);
					}}
					onCancel={() => {
						setPending(null);
						setFailure(null);
					}}
				/>
			)}
		</>
	);
}

type JobOption = { job_id: string; job_name?: string | null; job_number?: string | null };

/** Asked once, after the shot. A bottom sheet because it is answered one-handed. */
function JobChooser({
	jobs,
	jobsLoading,
	jobsFailed,
	busyJobId,
	failure,
	onPick,
	onRetake,
	onCancel,
}: {
	jobs: JobOption[];
	jobsLoading: boolean;
	jobsFailed: boolean;
	busyJobId: string | null;
	failure: string | null;
	onPick: (jobId: string) => void;
	onRetake: () => void;
	onCancel: () => void;
}) {
	const busy = busyJobId !== null;
	// Escape, initial focus, the Tab trap and focus return, same as ApprovalSheet.
	const dialogProps = useDialogA11y<HTMLDivElement>(() => {
		if (!busy) onCancel();
	});

	// z-[60], not z-50: the technician layout's bottom nav is fixed at z-50 and
	// later in the DOM, so a matching z-index leaves it painting over Retake/Cancel.
	return (
		<div
			{...dialogProps}
			aria-label="Which job is this for?"
			className="fixed inset-0 z-[60] flex items-end bg-overlay"
		>
			<div className="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-canvas p-4">
				<h2 className="text-sm font-semibold text-text-primary">Which job is this for?</h2>
				<p className="mt-1 text-xs text-text-muted">
					The receipt is saved. This is what puts the cost on the right invoice.
				</p>

				{failure && <p className="mt-2 text-xs text-warning-text">{failure}</p>}

				{jobsLoading ? (
					<p className="mt-3 text-sm text-text-muted">Loading your jobs…</p>
				) : jobsFailed ? (
					// Distinct from the empty case on purpose, same as ApprovalSheet:
					// "no jobs assigned" reads as dispatch's doing and sends the
					// technician to argue with the wrong person over a dropped request.
					<p className="mt-3 text-sm text-warning-text">
						Could not load your jobs. Check your signal — the photo is saved, so
						Retake is not needed.
					</p>
				) : jobs.length === 0 ? (
					<p className="mt-3 text-sm text-text-muted">
						You have no jobs assigned right now — dispatch has to attach this one.
					</p>
				) : (
					<ul className="mt-3 space-y-2">
						{jobs.map((j) => (
							<li key={j.job_id}>
								<button
									type="button"
									disabled={busy}
									onClick={() => onPick(j.job_id)}
									className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-base px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-surface disabled:opacity-40"
								>
									{busyJobId === j.job_id && (
										<Loader2 aria-hidden size={14} className="animate-spin" />
									)}
									<span className="min-w-0 truncate">
										{j.job_name || `Job ${j.job_number ?? ""}`.trim()}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}

				<div className="mt-3 flex gap-2">
					<button
						type="button"
						disabled={busy}
						onClick={onRetake}
						className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-text-primary disabled:opacity-40"
					>
						Retake
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={onCancel}
						className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-text-secondary hover:enabled:bg-surface-raised disabled:opacity-40"
					>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
