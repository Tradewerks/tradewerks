import { useState, useEffect } from "react";
import { Send, X, Mail, FileText, Loader2, AlertCircle } from "lucide-react";
import FullPopup from "./FullPopup";
import { errorMessage } from "../../util/util";

interface SendDocumentModalProps {
	isOpen: boolean;
	onClose: () => void;
	/** Called when the user confirms. Receives the (possibly edited) recipient email. */
	onSend: (email: string) => Promise<void>;
	docType: "quote" | "invoice";
	docNumber: string;
	clientName: string;
	/** Pre-filled recipient email from the client's primary contact. */
	contactEmail?: string | null;
	contactName?: string | null;
}

export default function SendDocumentModal({
	isOpen,
	onClose,
	onSend,
	docType,
	docNumber,
	clientName,
	contactEmail,
	contactName,
}: SendDocumentModalProps) {
	const [email, setEmail] = useState(contactEmail ?? "");
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Sync email when modal opens with fresh contact data
	useEffect(() => {
		if (isOpen) {
			setEmail(contactEmail ?? "");
			setError(null);
		}
	}, [isOpen, contactEmail]);

	const docLabel = docType === "quote" ? "Quote" : "Invoice";
	const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

	const handleSend = async () => {
		if (!emailIsValid) {
			setError("Please enter a valid email address.");
			return;
		}
		setIsSending(true);
		setError(null);
		try {
			await onSend(email.trim());
			onClose();
		} catch (err: unknown) {
			// This changeset added the pre-email transition guards so the
			// dispatcher could read why a stale-tab send is refused; that
			// sentence is on the response envelope, not AxiosError.message.
			setError(errorMessage(err, "Failed to send. Please try again."));
		} finally {
			setIsSending(false);
		}
	};

	const content = (
		<div className="flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
				<div className="flex items-center gap-2">
					<Send size={18} className="text-primary-text" />
					<h2 className="text-base font-semibold text-primary">
						Send {docLabel} to Client
					</h2>
				</div>
				<button
					onClick={onClose}
					className="p-1.5 hover:bg-surface rounded-md transition-colors text-text-tertiary hover:text-text-primary"
				>
					<X size={16} />
				</button>
			</div>

			{/* Body */}
			<div className="px-6 py-5 space-y-5">
				{/* Document summary */}
				<div className="flex items-start gap-3 p-3 bg-surface/50 rounded-lg border border-border/50">
					<FileText size={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
					<div>
						<p className="text-sm font-medium text-primary">{docNumber}</p>
						<p className="text-xs text-text-tertiary mt-0.5">
							{docLabel} for{" "}
							<span className="text-text-secondary">{clientName}</span>
						</p>
					</div>
				</div>

				{/* Recipient */}
				<div>
					<label className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
						Recipient
					</label>
					{contactName && (
						<p className="text-xs text-text-muted mb-2">{contactName}</p>
					)}
					<div className="relative">
						<Mail
							size={14}
							className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
						/>
						<input
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value);
								setError(null);
							}}
							placeholder="recipient@example.com"
							className="w-full pl-9 pr-3 py-2.5 bg-surface-inset border border-border rounded-md text-sm text-primary placeholder:text-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary-border transition-colors"
						/>
					</div>
					{!contactEmail && (
						<p className="mt-1.5 text-xs text-warning-text flex items-center gap-1">
							<AlertCircle size={12} />
							No primary contact email on file — enter one to proceed.
						</p>
					)}
				</div>

				{/* Error */}
				{error && (
					<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
						<AlertCircle size={14} className="text-error-text flex-shrink-0" />
						<p className="text-sm text-error-text">{error}</p>
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
				<button
					onClick={onClose}
					disabled={isSending}
					className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onClick={handleSend}
					disabled={isSending || !emailIsValid}
					className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary-hover hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-md transition-colors"
				>
					{isSending ? (
						<Loader2 size={14} className="animate-spin" />
					) : (
						<Send size={14} />
					)}
					{isSending ? "Sending..." : `Send ${docLabel}`}
				</button>
			</div>
		</div>
	);

	return (
		<FullPopup
			content={content}
			isModalOpen={isOpen}
			onClose={onClose}
			size="md"
		/>
	);
}
