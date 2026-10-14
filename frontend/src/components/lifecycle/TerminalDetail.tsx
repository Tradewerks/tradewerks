import { formatDate } from "../../util/util";

interface TerminalDetailProps {
	/** The recorded reason — the whole point of the terminal stage. */
	reason?: string | null;
	/** When it was recorded, where the document stores one. */
	at?: Date | string | null;
	/** What to say instead when nothing was recorded. Copy belongs to the page. */
	noReasonLabel: string;
}

/**
 * The terminal stage's body, in place of the stepper.
 *
 * It does NOT print the status word. The header pill already carries it, and
 * saying it again forty pixels lower was one of three places this page said the
 * same thing — on a quote past its valid-until date the two even disagreed, the
 * pill reading the persisted `Sent` while the bar read the derived `Expired`.
 * What stays is what the pill cannot carry: the reason and its date.
 *
 * Shared by quote and invoice. The invoice used to hardcode `"Void"` and a
 * reason paragraph inline while the quote used a component — the same concept,
 * two implementations, which is exactly the drift criterion 9 exists to stop.
 */
export default function TerminalDetail({ reason, at, noReasonLabel }: TerminalDetailProps) {
	return (
		<div className="min-w-0">
			<p
				className={`text-sm break-words ${
					reason ? "text-text-primary" : "text-text-tertiary italic"
				}`}
			>
				{reason || noReasonLabel}
			</p>
			{at && (
				<p className="mt-0.5 text-xs text-text-tertiary">
					Recorded {formatDate(at)}
				</p>
			)}
		</div>
	);
}
