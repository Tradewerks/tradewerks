import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { platform, platformError } from "../api";
import { AuthCard, primaryButtonClass } from "../components/AuthCard";
import MfaStep from "../components/MfaStep";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";

const INVALID = "This setup link is invalid or has expired. Sign in again for a new one.";

export default function EnrollPage() {
	const [params] = useSearchParams();
	const token = params.get("token") ?? "";
	const [pendingToken, setPendingToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (pendingToken) return <MfaStep stage="enroll" pendingToken={pendingToken} />;

	// The link works once, so it is spent on a click, not on load: a mail scanner that
	// opens the page, or a remounted effect, must not use it up.
	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			setPendingToken((await platform.exchangeEnrollLink(token)).pendingToken);
		} catch (err) {
			setError(platformError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthCard title="Set up two-step sign-in">
			<div className="space-y-4">
				{(error || !token) && <FormErrorBanner message={error ?? INVALID} />}
				<p className="text-sm text-text-secondary">
					Add the back office to your authenticator app to finish signing in.
				</p>
				{token && (
					<button
						type="button"
						className={primaryButtonClass}
						disabled={busy}
						onClick={start}
					>
						Continue
					</button>
				)}
				<Link to="/platform/login" className="text-sm text-primary hover:underline">
					Go to sign in
				</Link>
			</div>
		</AuthCard>
	);
}
