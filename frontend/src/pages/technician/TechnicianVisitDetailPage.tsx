import { useParams } from "react-router-dom";
import {
	Users,
	Car,
	MapPin,
	ChevronDown,
	ChevronUp,
	Phone,
	Mail,
	ChevronRight,
	AlertTriangle,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useJobVisitByIdQuery } from "../../hooks/useJobs";
import VisitActionButtons from "../../components/technicianComponents/VisitActionButtons";
import TechnicianQuoteModal from "../../components/quotes/TechnicianQuoteModal";
import WorkPerformedSection from "../../components/technicianComponents/WorkPerformedSection";
import PartsUsedSection from "../../components/technicianComponents/PartsUsedSection";
import CustomerHistorySection from "../../components/technicianComponents/CustomerHistorySection";
import InvoicePreview from "../../components/technicianComponents/InvoicePreview";
import { VisitStatusColors, VisitStatusLabels, type VisitStatus } from "../../types/jobs";
import { QuoteStatusColors, QuoteStatusLabels } from "../../types/quotes";
import { formatDateTime, formatTime, FALLBACK_TIMEZONE } from "../../util/util";
import { formatElapsed, resolveWorkTimerStart } from "../../util/elapsedUtil";
import { useAuthStore } from "../../auth/authStore";
import { ProjectStatusColors, ProjectStatusLabels } from "../../types/project";
import StartPurchaseButton from "../../components/technician/procurement/StartPurchaseButton";
import RequestApprovalButton from "../../components/technician/procurement/RequestApprovalButton";
import TechPage from "../../components/technician/TechPage";

// ── Field purchases ───────────────────────────────────────────────────────────

/**
 * Both ways a part gets bought mid-visit, the same fork the purchases page offers.
 * A technician on the job can ask dispatch first or record a receipt after paying
 * — not just the already-paid half, which would otherwise be the one case where
 * their own money is at stake with no way to ask first.
 */
function FieldPurchaseActions({ jobId, visitId }: { jobId: string | null; visitId: string }) {
	return (
		<section className="space-y-2" aria-labelledby="field-purchases-heading">
			<div>
				<h2
					id="field-purchases-heading"
					className="text-xs font-semibold uppercase tracking-wide text-text-secondary"
				>
					Field Purchases
				</h2>
				<p className="mt-1 text-xs text-text-muted">
					Parts bought at a store or supply house. Parts off your truck go
					in Parts Used.
				</p>
			</div>
			<StartPurchaseButton
				job={jobId ? { id: jobId, visitId } : null}
				label="Record a field purchase"
				hint="Already paid at the counter. Photograph the receipt to get reimbursed and put the cost on the job."
			/>
			<RequestApprovalButton preselectedJobId={jobId} />
		</section>
	);
}

// ── Elapsed Timer ─────────────────────────────────────────────────────────────

function ElapsedTimer({ startAt }: { startAt: string }) {
	const [elapsed, setElapsed] = useState(() =>
		Math.floor((Date.now() - new Date(startAt).getTime()) / 1000)
	);

	useEffect(() => {
		setElapsed(Math.floor((Date.now() - new Date(startAt).getTime()) / 1000));
		const id = setInterval(() => {
			setElapsed(Math.floor((Date.now() - new Date(startAt).getTime()) / 1000));
		}, 1000);
		return () => clearInterval(id);
	}, [startAt]);

	const label = formatElapsed(elapsed);

	return (
		<div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-success-bg border border-success/20">
			<span className="relative flex h-2 w-2 flex-shrink-0">
				<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-bright-text opacity-60" />
				<span className="relative inline-flex h-2 w-2 rounded-full bg-visit-completed" />
			</span>
			<span className="text-xs text-success-text font-medium uppercase tracking-wide">
				In Progress
			</span>
			<span className="ml-auto text-sm font-bold tabular-nums text-success-bright-text">
				{label}
			</span>
		</div>
	);
}

// ── Collapsible Job Context ───────────────────────────────────────────────────

function JobContextSection({
	visit,
	tz,
	defaultOpen = true,
	onViewQuote,
}: {
	visit: ReturnType<typeof useJobVisitByIdQuery>["data"];
	tz: string;
	defaultOpen?: boolean;
	onViewQuote: () => void;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const job = visit?.job;
	const primaryContact = job?.client?.contacts?.find((cc) => cc.is_primary)?.contact ?? null;

	return (
		<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
			<button
				onClick={() => setOpen((p) => !p)}
				className="w-full flex items-center justify-between px-4 py-3 border-b border-border-subtle"
			>
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
					Job Context
				</span>
				{open ? (
					<ChevronUp size={14} className="text-text-muted" />
				) : (
					<ChevronDown size={14} className="text-text-muted" />
				)}
			</button>

			{open && (
				<div className="p-4 space-y-3 bg-surface">
					{job && (
						<>
							<div>
								<p className="text-xs text-text-muted mb-0.5">
									Job
								</p>
								<p className="text-sm font-medium text-text-primary">
									#{job.job_number} ·{" "}
									{job.name}
								</p>
							</div>
							{job.project && (
								<div>
									<p className="text-xs text-text-muted mb-0.5"> Project</p>
									<div className="flex items-center gap-2">
										<p className="text-sm font-medium text-text-primary">
											{job.project.project_number}  ·  {job.project.name}
										</p>
										<span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border
											${ProjectStatusColors[job.project.status]}`}
										>
											{ProjectStatusLabels[job.project.status]}
										</span>
									</div>
								</div>
							)}
							{job.address && (
								<div>
									<p className="text-xs text-text-muted mb-0.5">
										Address
									</p>
									<a
										href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
										target="_blank"
										rel="noreferrer"
										className="flex items-center gap-1.5 text-sm text-primary-text hover:text-primary-text"
									>
										<MapPin size={13} />
										{job.address}
									</a>
									{visit?.estimated_drive_miles != null && (
										<p className="text-xs text-text-muted mt-0.5">
											{visit.estimated_drive_miles.toFixed(1)} mi from driving
										</p>
									)}
								</div>
							)}
							{job.description && (
								<div>
									<p className="text-xs text-text-muted mb-0.5">
										Description
									</p>
									<p className="text-sm text-text-secondary break-words">
										{job.description}
									</p>
								</div>
							)}
						</>
					)}

					{visit?.description && (
						<div>
							<p className="text-xs text-text-muted mb-0.5">
								Visit Notes
							</p>
							<p className="text-sm text-text-secondary break-words">
								{visit.description}
							</p>
						</div>
					)}

					<div>
						<p className="text-xs text-text-muted mb-0.5">
							Scheduled
						</p>
						<p className="text-sm text-text-secondary">
							{visit
								? `${formatDateTime(visit.scheduled_start_at, tz)} – ${formatTime(visit.scheduled_end_at, tz)}`
								: "—"}
						</p>
					</div>

					{visit?.visit_techs && visit.visit_techs.length > 0 && (
						<div>
							<p className="text-xs text-text-muted mb-1.5 flex items-center gap-1.5">
								<Users size={11} /> Assigned
								Technicians
							</p>
							<div className="flex flex-wrap gap-1.5">
								{visit.visit_techs.map((vt) => (
									<span
										key={vt.tech_id}
										className="inline-flex items-center px-2.5 py-1 rounded-full text-xs bg-surface border border-border text-text-secondary"
									>
										{vt.tech?.name ??
											vt.tech_id}
									</span>
								))}
							</div>
						</div>
					)}

					{job?.quote && (
						<button
							onClick={onViewQuote}
							className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface border border-border hover:bg-surface-raised transition-colors"
						>
							<div className="text-left">
								<p className="text-xs text-text-muted">
									Quote
								</p>
								<p className="text-sm font-medium text-text-primary">
									#{job.quote.quote_number} ·{" "}
									{job.quote.title}
								</p>
							</div>
							<div className="flex items-center gap-2">
								<span
									className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${
										QuoteStatusColors[
											job.quote
												.status as keyof typeof QuoteStatusColors
										] ??
										"bg-neutral/20 text-text-secondary border-border-strong/30"
									}`}
								>
									{QuoteStatusLabels[
										job.quote
											.status as keyof typeof QuoteStatusLabels
									] ?? job.quote.status}
								</span>
								<ChevronRight
									size={14}
									className="text-text-muted"
								/>
							</div>
						</button>
					)}

					{/* Client contact */}
					{job?.client && (
						<div className="border-t border-border-subtle pt-3 space-y-2">
							<div>
								<p className="text-xs text-text-muted mb-0.5">
									Client
								</p>
								<p className="text-sm font-semibold text-text-secondary">
									{job.client.name}
								</p>
								{primaryContact && (
									<p className="text-xs text-text-muted mt-0.5">
										{
											primaryContact.name
										}
										{primaryContact.type
											? ` · ${primaryContact.type.charAt(0).toUpperCase()}${primaryContact.type.slice(1)}`
											: ""}
									</p>
								)}
							</div>
							{primaryContact ? (
								<div className="flex gap-2">
									{primaryContact.phone ? (
										<a
											href={`tel:${primaryContact.phone}`}
											title={
												primaryContact.phone ??
												undefined
											}
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-success/10 border border-success/20 text-xs font-semibold text-success-text hover:bg-success/15 transition-colors"
										>
											<Phone
												size={
													12
												}
											/>
											Call
										</a>
									) : (
										<span
											role="button"
											aria-disabled="true"
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-surface border border-border text-xs font-semibold text-text-faint opacity-50 cursor-not-allowed"
										>
											<Phone
												size={
													12
												}
											/>
											No phone
										</span>
									)}
									{primaryContact.email ? (
										<a
											href={`mailto:${primaryContact.email}`}
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-surface border border-border text-xs font-semibold text-text-tertiary hover:bg-surface-raised hover:text-text-primary transition-colors"
										>
											<Mail
												size={
													12
												}
											/>
											Email
										</a>
									) : (
										<span
											role="button"
											aria-disabled="true"
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-surface border border-border text-xs font-semibold text-text-faint opacity-50 cursor-not-allowed"
										>
											<Mail
												size={
													12
												}
											/>
											Email
										</span>
									)}
								</div>
							) : (
								<p className="text-xs text-text-faint italic">
									No contact on file
								</p>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── Driving Arrival Banner ────────────────────────────────────────────────────

function ArrivalBanner({
	scheduledStart,
	address,
	tz,
	distanceMiles,
}: {
	scheduledStart: Date | string;
	address?: string;
	tz: string;
	distanceMiles?: number | null;
}) {
	const [countdown, setCountdown] = useState(() => {
		const diff = new Date(scheduledStart).getTime() - Date.now();
		return diff > 0 ? Math.ceil(diff / 60_000) : 0;
	});

	useEffect(() => {
		const id = setInterval(() => {
			const diff = new Date(scheduledStart).getTime() - Date.now();
			setCountdown(diff > 0 ? Math.ceil(diff / 60_000) : 0);
		}, 30_000);
		return () => clearInterval(id);
	}, [scheduledStart]);

	return (
		<div className="rounded-xl border border-info/25 bg-info/5 p-4 space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Car size={16} className="text-info-text" />
					<span className="text-sm font-semibold text-info-text">
						En Route
					</span>
				</div>
				{countdown > 0 ? (
					<span className="text-sm tabular-nums text-info-text font-bold">
						{countdown} min to start
					</span>
				) : (
					<span className="text-sm text-warning-text font-bold">
						Arrival time passed
					</span>
				)}
			</div>

			{address && (
				<a
					href={`https://maps.google.com/?q=${encodeURIComponent(address)}`}
					target="_blank"
					rel="noreferrer"
					className="flex items-center gap-2 text-sm text-primary-text hover:text-primary-text"
				>
					<MapPin size={14} />
					{address}
				</a>
			)}

			<div className="flex items-center justify-between">
				<p className="text-xs text-text-muted">
					Scheduled: {formatDateTime(scheduledStart, tz)}
				</p>
				{distanceMiles != null && (
					<span className="text-xs text-info-text font-medium tabular-nums">
						{distanceMiles.toFixed(1)} mi
					</span>
				)}
			</div>
		</div>
	);
}

// ── Delayed Banner ────────────────────────────────────────────────────────────

function DelayedBanner({ scheduledStart, tz }: { scheduledStart: Date | string; tz: string }) {
	const overdueMs = Math.max(0, Date.now() - new Date(scheduledStart).getTime());
	const overdueMin = Math.floor(overdueMs / 60_000);
	const overdueLabel =
		overdueMin >= 60
			? `${Math.floor(overdueMin / 60)}h ${overdueMin % 60}m past scheduled start`
			: overdueMin > 0
				? `${overdueMin}m past scheduled start`
				: null;

	return (
		<div className="rounded-xl border border-orange/25 bg-orange/5 p-4 space-y-1.5">
			<div className="flex items-center gap-2">
				<AlertTriangle size={15} className="text-orange-text shrink-0" />
				<span className="text-sm font-semibold text-orange-text">Visit Delayed</span>
			</div>
			<p className="text-xs text-text-tertiary">
				Scheduled: {formatDateTime(scheduledStart, tz)}
			</p>
			{overdueLabel && (
				<p className="text-xs text-orange-text/80">{overdueLabel}</p>
			)}
		</div>
	);
}

// ── Paused Banner ─────────────────────────────────────────────────────────────

function PausedBanner() {
	return (
		<div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-warning-bg border border-warning/20">
			<span className="h-2 w-2 rounded-full bg-visit-paused-text flex-shrink-0" />
			<span className="text-xs text-warning-text font-medium uppercase tracking-wide flex-1">
				Visit Paused
			</span>
			<span className="text-xs text-text-muted">
				Clock in to resume
			</span>
		</div>
	);
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TechnicianVisitDetailPage() {
	const { visitId } = useParams<{ visitId: string }>();
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const { data: visit, isLoading } = useJobVisitByIdQuery(visitId!);
	const [showQuoteModal, setShowQuoteModal] = useState(false);

	if (isLoading) {
		return (
			<TechPage className="space-y-4 animate-pulse">
				<div className="h-7 w-48 bg-surface rounded" />
				<div className="h-4 w-32 bg-surface rounded" />
				<div className="h-24 bg-surface rounded-xl" />
				<div className="h-32 bg-surface rounded-xl" />
			</TechPage>
		);
	}

	if (!visit) {
		return (
			<div className="flex items-center justify-center h-64">
				<p className="text-text-muted">Visit not found</p>
			</div>
		);
	}

	const job = visit.job;
	const status = visit.status as VisitStatus;
	const clientId = job?.client_id ?? null;

	const lineItems = visit.line_items ?? [];
	const timerStartAt = resolveWorkTimerStart(visit, user?.userId);
	const subtotal = Number(visit.subtotal ?? 0);
	const taxRate = Number(visit.tax_rate ?? 0);
	const taxAmount = Number(visit.tax_amount ?? 0);
	const total = Number(visit.total ?? 0);

	// ── Status-aware sections ─────────────────────────────────────────────────

	const renderContent = () => {
		switch (status) {
			case "Scheduled":
				return (
					<>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen
							onViewQuote={() => setShowQuoteModal(true)}
						/>
						{lineItems.length > 0 && (
							<InvoicePreview
								lineItems={lineItems}
								subtotal={subtotal}
								taxRate={taxRate}
								taxAmount={taxAmount}
								total={total}
							/>
						)}
						{clientId && (
							<CustomerHistorySection
								clientId={clientId}
								currentVisitId={visitId!}
							/>
						)}
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
					</>
				);

			case "Delayed":
				return (
					<>
						<DelayedBanner
							scheduledStart={visit.scheduled_start_at}
							tz={tz}
						/>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen
							onViewQuote={() => setShowQuoteModal(true)}
						/>
						{lineItems.length > 0 && (
							<InvoicePreview
								lineItems={lineItems}
								subtotal={subtotal}
								taxRate={taxRate}
								taxAmount={taxAmount}
								total={total}
							/>
						)}
						{clientId && (
							<CustomerHistorySection
								clientId={clientId}
								currentVisitId={visitId!}
							/>
						)}
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
					</>
				);

			case "Driving":
				return (
					<>
						<ArrivalBanner
							scheduledStart={visit.scheduled_start_at}
							address={job?.address}
							tz={tz}
							distanceMiles={visit.estimated_drive_miles}
						/>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen={false}
							onViewQuote={() => setShowQuoteModal(true)}
						/>
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
					</>
				);

			case "OnSite":
				return (
					<>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen
							onViewQuote={() => setShowQuoteModal(true)}
						/>
						{lineItems.length > 0 && (
							<InvoicePreview
								lineItems={lineItems}
								subtotal={subtotal}
								taxRate={taxRate}
								taxAmount={taxAmount}
								total={total}
							/>
						)}
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
						<FieldPurchaseActions jobId={visit.job_id} visitId={visit.id} />
					</>
				);

			case "InProgress":
				return (
					<>
						{timerStartAt && (
							<ElapsedTimer startAt={timerStartAt} />
						)}
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
						<PartsUsedSection
							visitId={visitId!}
							lineItems={lineItems}
						/>
						<FieldPurchaseActions jobId={visit.job_id} visitId={visit.id} />
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen={false}
							onViewQuote={() => setShowQuoteModal(true)}
						/>
					</>
				);

			case "Paused":
				return (
					<>
						<PausedBanner />
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
						<PartsUsedSection
							visitId={visitId!}
							lineItems={lineItems}
						/>
						<InvoicePreview
							lineItems={lineItems}
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							total={total}
						/>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen={false}
							onViewQuote={() => setShowQuoteModal(true)}
						/>
					</>
				);

			case "Completed":
				return (
					<>
						<InvoicePreview
							lineItems={lineItems}
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							total={total}
							isCompleted
						/>
						<WorkPerformedSection
							jobId={visit.job_id}
							visitId={visitId!}
						/>
						<JobContextSection
							visit={visit}
							tz={tz}
							defaultOpen={false}
							onViewQuote={() => setShowQuoteModal(true)}
						/>
						{clientId && (
							<CustomerHistorySection
								clientId={clientId}
								currentVisitId={visitId!}
							/>
						)}
					</>
				);

			default:
				return (
					<JobContextSection
						visit={visit}
						tz={tz}
						defaultOpen
						onViewQuote={() => setShowQuoteModal(true)}
					/>
				);
		}
	};

	// Not part of the auth User shape yet; read defensively so the button only shows when present.
	const dispatchPhone =
		user && "dispatchPhone" in user && typeof user.dispatchPhone === "string"
			? user.dispatchPhone
			: undefined;

	return (
		<TechPage className="pb-28">
			{/* Header */}
			<div className="mb-5">
				<h1 className="text-xl font-bold text-text-primary leading-snug">
					<span
						className={`float-right ml-3 mt-0.5 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
							VisitStatusColors[status] ??
							"bg-neutral/20 text-text-tertiary border-border-strong/30"
						}`}
					>
						{VisitStatusLabels[status] ?? status}
					</span>
					{visit.name ?? "Visit"}
				</h1>
				{job?.client?.name && (
					<p className="text-sm text-text-tertiary mt-0.5">
						{job.client.name}
					</p>
				)}
			</div>

			{/* Status-aware content */}
			<div className="space-y-4">{renderContent()}</div>

			{/* Quote modal */}
			{showQuoteModal && job?.quote?.id && (
				<TechnicianQuoteModal
					quoteId={job.quote.id}
					onClose={() => setShowQuoteModal(false)}
				/>
			)}

{/* Sticky footer CTA */}
			{status !== "Completed" && status !== "Cancelled" && (
				<div className="fixed bottom-16 left-0 right-0 z-40 px-4 pb-3 bg-gradient-to-t from-canvas via-canvas/95 to-transparent pt-6">
					<TechPage className="flex gap-2">
						<div className="flex-1">
							<VisitActionButtons
								visit={visit}
								techId={user?.userId ?? ""}
								variant="detail"
							/>
						</div>
						{dispatchPhone && (
							<a
								href={`tel:${dispatchPhone}`}
								className="flex items-center justify-center w-12 rounded-xl bg-surface border border-border text-text-tertiary hover:text-text-primary transition-colors self-start"
								title="Call Dispatch"
							>
								<Phone size={18} />
							</a>
						)}
					</TechPage>
				</div>
			)}
		</TechPage>
	);
}
