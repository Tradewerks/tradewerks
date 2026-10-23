import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { TaxReviewKind } from "../../api/taxSettings";
import { useAcknowledgeTaxReview } from "../../hooks/useTaxSettings";
import { errorMessage } from "../../util/util";

export interface TaxReviewBannerProps {
	kind: TaxReviewKind;
	id: string;
	needsReview: boolean | undefined;
	reason: string | null | undefined;
	ackAt: string | null | undefined;
	canAcknowledge: boolean;
}

export default function TaxReviewBanner({
	kind,
	id,
	needsReview,
	reason,
	ackAt,
	canAcknowledge,
}: TaxReviewBannerProps) {
	const acknowledge = useAcknowledgeTaxReview();
	const [error, setError] = useState<string | null>(null);

	if (!needsReview) return null;

	if (ackAt) {
		const when = new Date(ackAt).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		return (
			<p className="flex items-center gap-1.5 text-xs text-text-muted">
				<CheckCircle2 size={12} aria-hidden="true" />
				Tax review acknowledged · {when}
			</p>
		);
	}

	const onAcknowledge = async () => {
		setError(null);
		try {
			await acknowledge.mutateAsync({ kind, id });
		} catch (err) {
			setError(errorMessage(err, "Couldn't acknowledge the tax review."));
		}
	};

	return (
		<div
			role="status"
			className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2"
		>
			<AlertTriangle
				size={14}
				className="mt-0.5 shrink-0 text-warning-text"
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium text-warning-text">
					Check the tax on this {kind}
				</p>
				<p className="text-xs text-text-secondary">
					{reason ??
						"The tax rate could not be confirmed automatically."}
				</p>
				<p className="text-xs text-text-muted">
					{canAcknowledge
						? "Confirm the tax is right for this address, then acknowledge."
						: `Someone who can send this ${kind} needs to confirm the tax.`}
				</p>
				{error && <p className="mt-1 text-xs text-error-text">{error}</p>}
			</div>
			{canAcknowledge && (
				<button
					type="button"
					onClick={onAcknowledge}
					disabled={acknowledge.isPending}
					className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warning-border px-2.5 py-1 text-xs font-medium text-warning-text transition-colors hover:bg-warning-text/10 disabled:opacity-60"
				>
					{acknowledge.isPending && (
						<Loader2
							size={12}
							className="animate-spin"
							aria-hidden="true"
						/>
					)}
					Acknowledge
				</button>
			)}
		</div>
	);
}
