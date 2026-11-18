import { useEffect, useRef, useState } from "react";
import { isAxiosError } from "axios";
import {
	markPublicLinkViewed,
	respondToPublicQuote,
	type PublicQuote,
	type QuoteLinkData,
} from "../../api/publicLinks";
import { PdfButton, PublicLineItems, TotalRow } from "./PublicDocumentParts";
import {
	brandButtonStyle,
	formatPublicInstant,
	inputClass,
	primaryButtonClass,
	secondaryButtonClass,
	textButtonClass,
} from "./publicStyles";

interface Props {
	token: string;
	data: QuoteLinkData;
}

// Mirrors the server's rule so the button only enables for a name it will accept.
const validName = (n: string) => {
	const t = n.trim();
	return t.length >= 2 && t.length <= 100 && /\p{L}/u.test(t) && !/\p{C}/u.test(t);
};

function outcome(q: PublicQuote, orgName: string): string | null {
	if (q.superseded)
		return `This quote was replaced. Contact ${orgName} for the current version.`;
	switch (q.status) {
		case "Approved":
			return [
				"Approved",
				q.approved_by_name && `by ${q.approved_by_name}`,
				q.approved_at && `on ${formatPublicInstant(q.approved_at)}`,
			]
				.filter(Boolean)
				.join(" ");
		case "Rejected":
			return "This quote was declined.";
		case "Expired":
			return `This quote has expired. Contact ${orgName} for an updated quote.`;
		case "Disputed":
			return `Contact ${orgName} about this quote.`;
		case "Cancelled":
			return `This quote was withdrawn. Contact ${orgName} with any questions.`;
		default:
			return q.can_respond ? null : `To approve this quote, contact ${orgName}.`;
	}
}

export default function QuoteView({ token, data }: Props) {
	const { org } = data;
	const [quote, setQuote] = useState<PublicQuote>(data);
	const [name, setName] = useState("");
	const [declining, setDeclining] = useState(false);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const viewed = useRef(false);
	useEffect(() => {
		if (viewed.current) return;
		viewed.current = true;
		// Best effort: failing to record a view must never disturb the customer.
		markPublicLinkViewed(token).catch(() => {});
	}, [token]);

	const submit = async (action: "approve" | "decline") => {
		setBusy(true);
		setError("");
		try {
			setQuote(
				await respondToPublicQuote(
					token,
					action,
					name.trim(),
					action === "decline"
						? reason.trim() || undefined
						: undefined
				)
			);
		} catch (err) {
			const status = isAxiosError(err) ? err.response?.status : undefined;
			setError(
				status === 400
					? "Enter your full name as it should appear on the approval."
					: status === 404
						? "This link is no longer valid."
						: "Could not send your answer. Try again."
			);
		} finally {
			setBusy(false);
		}
	};

	const message = outcome(quote, org.name);
	const canAnswer = validName(name) && !busy;

	return (
		<div className="space-y-5">
			<div>
				<p className="text-sm text-zinc-500">Quote {quote.number}</p>
				<h1 className="mt-0.5 break-words text-xl font-semibold">
					{quote.title}
				</h1>
				{quote.valid_until && quote.can_respond && (
					<p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
						Valid until {formatPublicInstant(quote.valid_until)}
					</p>
				)}
			</div>

			<PublicLineItems items={quote.line_items} />

			<dl className="space-y-1.5">
				<TotalRow label="Subtotal" amount={quote.subtotal} />
				{quote.discount_amount > 0 && (
					<TotalRow
						label="Discount"
						amount={-quote.discount_amount}
					/>
				)}
				{quote.tax_amount > 0 && (
					<TotalRow label="Tax" amount={quote.tax_amount} />
				)}
				<TotalRow label="Total" amount={quote.total} strong />
			</dl>

			{message ? (
				<p
					role="status"
					className="rounded-lg bg-zinc-100 px-4 py-3 text-center text-sm font-medium dark:bg-zinc-800"
				>
					{message}
				</p>
			) : (
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (canAnswer)
							submit(declining ? "decline" : "approve");
					}}
				>
					<div>
						<label
							htmlFor="quote-signer"
							className="block text-sm font-medium"
						>
							Your full name
						</label>
						<input
							id="quote-signer"
							type="text"
							autoComplete="name"
							maxLength={100}
							value={name}
							onChange={(e) => setName(e.target.value)}
							className={`${inputClass} min-h-12`}
						/>
						<p className="mt-1.5 text-xs text-zinc-500">
							Typing your name and approving counts as
							your signature.
						</p>
					</div>

					{declining ? (
						<>
							<div>
								<label
									htmlFor="quote-decline-reason"
									className="block text-sm font-medium"
								>
									Reason (optional)
								</label>
								<textarea
									id="quote-decline-reason"
									rows={3}
									maxLength={1000}
									value={reason}
									onChange={(e) =>
										setReason(
											e.target
												.value
										)
									}
									className={`${inputClass} py-2`}
								/>
							</div>
							<button
								type="submit"
								disabled={!canAnswer}
								className={secondaryButtonClass}
							>
								{busy
									? "Sending…"
									: "Decline quote"}
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => setDeclining(false)}
								className={textButtonClass}
							>
								Keep this quote
							</button>
						</>
					) : (
						<>
							<button
								type="submit"
								disabled={!canAnswer}
								style={brandButtonStyle(org)}
								className={primaryButtonClass}
							>
								{busy
									? "Sending…"
									: "Approve quote"}
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => setDeclining(true)}
								className={textButtonClass}
							>
								Decline
							</button>
						</>
					)}

					{error && (
						<p
							role="alert"
							className="text-center text-sm text-red-600 dark:text-red-400"
						>
							{error}
						</p>
					)}
				</form>
			)}

			{quote.status !== "Cancelled" && (
				<PdfButton token={token} filename={`quote-${quote.number}.pdf`} />
			)}
		</div>
	);
}
