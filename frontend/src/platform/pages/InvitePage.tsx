import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { platform, platformError } from "../api";
import { AuthCard, inputClass, labelClass, primaryButtonClass } from "../components/AuthCard";
import MfaStep from "../components/MfaStep";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";

const INVALID = "This invite link is invalid or has expired";

function Unavailable({ message }: { message: string }) {
	return (
		<AuthCard title="Invite unavailable">
			<p className="text-sm text-text-secondary">{message}</p>
			<Link to="/platform/login" className="text-sm text-primary hover:underline">
				Go to sign in
			</Link>
		</AuthCard>
	);
}

export default function InvitePage() {
	const [params] = useSearchParams();
	const token = params.get("token") ?? "";
	const [invite, setInvite] = useState<{ email: string; name: string } | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [pendingToken, setPendingToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!token) return;
		platform.previewInvite(token).then(
			(r) => {
				setInvite(r);
				setName(r.name);
			},
			(e) => setLoadError(platformError(e))
		);
	}, [token]);

	if (!token) return <Unavailable message={INVALID} />;
	if (loadError) return <Unavailable message={loadError} />;
	if (pendingToken) return <MfaStep stage="enroll" pendingToken={pendingToken} />;
	if (!invite)
		return (
			<AuthCard title="Accept your invite">
				<div className="h-9 animate-pulse rounded-md bg-surface-inset" />
			</AuthCard>
		);

	const mismatch = confirm.length > 0 && confirm !== password;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (mismatch) return;
		setBusy(true);
		setError(null);
		try {
			setPendingToken(
				(await platform.acceptInvite({ token, name, password }))
					.pendingToken
			);
		} catch (err) {
			setError(platformError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthCard title="Accept your invite">
			<form onSubmit={submit} className="space-y-4">
				{error && <FormErrorBanner message={error} />}
				<div>
					<p className={labelClass}>Email</p>
					<p className="text-sm text-text-primary">{invite.email}</p>
				</div>
				<div>
					<label htmlFor="pf-name" className={labelClass}>
						Name
					</label>
					<input
						id="pf-name"
						className={inputClass}
						autoComplete="name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
				</div>
				<div>
					<label htmlFor="pf-password" className={labelClass}>
						Password
					</label>
					<input
						id="pf-password"
						type="password"
						className={inputClass}
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						minLength={12}
						required
					/>
					<p className="mt-1 text-xs text-text-tertiary">
						12 characters or more
					</p>
				</div>
				<div>
					<label htmlFor="pf-confirm" className={labelClass}>
						Confirm password
					</label>
					<input
						id="pf-confirm"
						type="password"
						className={inputClass}
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						required
					/>
					{mismatch && (
						<p className="mt-1 text-xs text-error-text">
							Passwords don't match
						</p>
					)}
				</div>
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={busy || mismatch}
				>
					Continue
				</button>
			</form>
		</AuthCard>
	);
}
