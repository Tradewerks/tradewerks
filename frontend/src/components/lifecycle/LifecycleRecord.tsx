import { Link } from "react-router-dom";
import Card from "../ui/Card";
import { OUTCOME_LABELS } from "../disputes/outcomes";
import type { Dispute } from "../../types/disputes";
import { formatDate } from "../../util/util";
import { documentStatusLabel } from "./documentStatusLabel";
import type { LifecycleKind } from "./types";

interface LifecycleRecordProps {
	disputes: Dispute[];
}

const routeFor = (kind: LifecycleKind, id: string) =>
	kind === "quote" ? `/dispatch/quotes/${id}` : `/dispatch/invoices/${id}`;

/**
 * What happened to this document.
 *
 * A resolved dispute used to disappear the moment it was resolved — the banner
 * rendered only while Open — leaving the outcome, the note, both actors and the
 * document the resolution produced stored and shown nowhere. The replacement
 * reached ChangeHistory as a bare UUID under a humanized key.
 *
 * Revision lineage used to live here too, as a row of ±1 chips. It moved to
 * DocumentLineage, above the fold: a dispatcher asking "is this the version
 * that counts" should not have to open the Activity tab to find out.
 *
 * It went with the `kind` prop, which those chips were the only reader of:
 * the one link left here routes by the kind of document the RESOLUTION
 * produced, which a dispute names itself.
 */
export default function LifecycleRecord({ disputes }: LifecycleRecordProps) {
	if (disputes.length === 0) return null;

	const ordered = [...disputes].sort(
		(a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime()
	);

	return (
		<Card title="Dispute History">
			<div className="space-y-4">
				{ordered.map((dispute) => {
					// Whichever document this resolution produced, if any.
					const producedId =
						dispute.replacement_quote_id ??
						dispute.replacement_invoice_id ??
						dispute.adjustment_invoice_id;
					const producedLabel = dispute.adjustment_invoice_id
						? "Adjustment"
						: "Replacement";
					// An adjustment is always an invoice, even on a quote's dispute.
					const producedKind: LifecycleKind =
						dispute.adjustment_invoice_id ||
						dispute.replacement_invoice_id
							? "invoice"
							: "quote";

					return (
						<div
							key={dispute.id}
							className="rounded-lg border border-border-subtle bg-surface/50 p-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span
									className={`rounded border px-1.5 py-0.5 text-xs ${
										dispute.status ===
										"Open"
											? "border-warning-border bg-warning-bg text-warning-text"
											: "border-border-strong bg-surface-raised text-text-secondary"
									}`}
								>
									{dispute.status}
								</span>
								{dispute.resolution && (
									<span className="text-sm font-medium text-text-primary">
										{
											OUTCOME_LABELS[
												dispute
													.resolution
											]
										}
									</span>
								)}
							</div>

							<p className="mt-2 break-words text-sm text-text-secondary">
								{dispute.reason}
							</p>

							<p className="mt-1 text-xs text-text-tertiary">
								Opened by{" "}
								{dispute.opened_by_dispatcher
									?.name ?? "someone"}{" "}
								on {formatDate(dispute.opened_at)} ·
								was{" "}
								{documentStatusLabel(
									dispute.document_kind,
									dispute.status_at_open
								)}{" "}
								when opened
							</p>

							{dispute.resolved_at && (
								<p className="mt-0.5 text-xs text-text-tertiary">
									Resolved by{" "}
									{dispute
										.resolved_by_dispatcher
										?.name ??
										"someone"}{" "}
									on{" "}
									{formatDate(
										dispute.resolved_at
									)}
								</p>
							)}

							{dispute.resolution_note && (
								<p className="mt-2 break-words text-xs text-text-secondary">
									{dispute.resolution_note}
								</p>
							)}

							{producedId && (
								<Link
									to={routeFor(
										producedKind,
										producedId
									)}
									className="mt-2 inline-flex items-center gap-1 text-xs text-primary-text underline transition-colors duration-150 ease-out hover:text-text-primary"
								>
									{producedLabel}
								</Link>
							)}
						</div>
					);
				})}
			</div>
		</Card>
	);
}
