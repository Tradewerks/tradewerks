import { useState } from "react";
import type { ZodError } from "zod";
import { Loader2, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import ClientPicker from "../clients/ClientPicker";
import { useSequencesQuery } from "../../hooks/useFollowups";
import { EnrollSchema, type EnrollInput } from "../../types/followups";
import { LABEL, INPUT } from "./shared";

interface EnrollModalProps {
	isModalOpen: boolean;
	onClose: () => void;
	isPending: boolean;
	onSubmit: (data: EnrollInput) => Promise<void>;
}

export default function EnrollModal({ isModalOpen, onClose, isPending, onSubmit }: EnrollModalProps) {
	const { data: sequences } = useSequencesQuery();

	const [clientId, setClientId] = useState("");
	const [sequenceId, setSequenceId] = useState("");
	const [recipientEmail, setRecipientEmail] = useState("");
	const [scheduledAt, setScheduledAt] = useState("");
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const activeSequences = (sequences ?? []).filter((s) => s.is_active);
	const selectedSequence = activeSequences.find((s) => s.id === sequenceId);
	const isReminderSequence = selectedSequence?.trigger_type === "visit_scheduled";

	const fieldErrors = (field: string) => errors?.issues.filter((e) => e.path[0] === field) ?? [];

	const handleSubmit = async () => {
		const raw = {
			sequence_id: sequenceId,
			client_id: clientId,
			recipient_email: recipientEmail.trim() || null,
			scheduled_at: scheduledAt || null,
		};

		const parsed = EnrollSchema.safeParse(raw);
		if (!parsed.success) {
			setErrors(parsed.error);
			return;
		}

		// A reminder (visit_scheduled) sequence fires relative to a visit time; without
		// it the first step would send immediately. Require the anchor date here.
		if (isReminderSequence && !scheduledAt) {
			setSubmitError("This reminder sequence needs a scheduled visit time.");
			return;
		}

		setErrors(null);
		setSubmitError(null);

		const data: EnrollInput = {
			sequence_id: sequenceId,
			client_id: clientId,
			...(recipientEmail.trim() ? { recipient_email: recipientEmail.trim() } : {}),
			...(scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
		};

		try {
			await onSubmit(data);
		} catch (e) {
			setSubmitError(e instanceof Error ? e.message : "Failed to enroll client.");
		}
	};

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap">
					Enroll Client
				</h2>
				<button
					onClick={onClose}
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors"
					disabled={isPending}
				>
					<X size={18} />
				</button>
			</div>

			<div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-4 space-y-4">
				<div>
					<label className={LABEL}>Client *</label>
					<ClientPicker
						value={clientId}
						onChange={setClientId}
						placeholder="─Select a client─"
						disabled={isPending}
					/>
					{fieldErrors("client_id").map((err) => (
						<p className="mt-1 text-xs text-error-text" key={err.message}>
							{err.message}
						</p>
					))}
				</div>

				<div>
					<label className={LABEL}>Sequence *</label>
					<select
						value={sequenceId}
						onChange={(e) => setSequenceId(e.target.value)}
						className={INPUT}
						disabled={isPending}
					>
						<option value="">─Select a sequence─</option>
						{activeSequences.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
					{fieldErrors("sequence_id").map((err) => (
						<p className="mt-1 text-xs text-error-text" key={err.message}>
							{err.message}
						</p>
					))}
					{activeSequences.length === 0 && (
						<p className="mt-1 text-xs text-text-muted">
							No active sequences available. Activate a sequence first.
						</p>
					)}
				</div>

				<div>
					<label className={LABEL}>Recipient Email Override</label>
					<input
						type="email"
						value={recipientEmail}
						onChange={(e) => setRecipientEmail(e.target.value)}
						className={INPUT}
						placeholder="Leave blank to use the client's primary contact"
						disabled={isPending}
					/>
					{fieldErrors("recipient_email").map((err) => (
						<p className="mt-1 text-xs text-error-text" key={err.message}>
							{err.message}
						</p>
					))}
				</div>

				<div>
					<label className={LABEL}>
						Scheduled At{isReminderSequence ? " *" : ""}
					</label>
					<input
						type="datetime-local"
						value={scheduledAt}
						onChange={(e) => setScheduledAt(e.target.value)}
						className={INPUT}
						disabled={isPending}
					/>
					<p className="mt-1 text-xs text-text-muted">
						{isReminderSequence
							? "Required: the visit time. Reminder steps send before this."
							: "Anchor time for date-based sequences. Leave blank to start immediately."}
					</p>
				</div>
			</div>

			<div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border bg-base flex-shrink-0">
				{submitError ? <p className="text-xs text-error-text">{submitError}</p> : <span />}
				<div className="flex items-center gap-2">
					<button
						onClick={onClose}
						disabled={isPending}
						className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors whitespace-nowrap"
					>
						Cancel
					</button>
					<button
						onClick={handleSubmit}
						disabled={isPending}
						className="inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-confirm hover:bg-confirm-hover text-sm font-semibold text-on-primary transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isPending && <Loader2 size={12} className="animate-spin" />}
						Enroll
					</button>
				</div>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={isModalOpen} onClose={onClose} />;
}
