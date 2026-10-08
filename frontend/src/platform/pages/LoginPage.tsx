import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { platform, platformError } from "../api";
import { isStaffTokenExpired, usePlatformAuth } from "../store";
import {
	AuthCard,
	inputClass,
	labelClass,
	PasswordInput,
	primaryButtonClass,
} from "../components/AuthCard";
import MfaStep from "../components/MfaStep";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";

export default function LoginPage() {
	const token = usePlatformAuth((s) => s.token);
	const notice = usePlatformAuth((s) => s.notice);
	const from = (useLocation().state as { from?: string } | null)?.from;
	const returnTo = from?.startsWith("/platform/") ? from : "/platform/orgs";
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [next, setNext] = useState<{ stage: "mfa" | "enroll"; pendingToken: string } | null>(
		null
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Only a confirmed "no staff account yet" shows the link; a failed check hides it.
	const [setupOpen, setSetupOpen] = useState(false);

	useEffect(() => {
		let live = true;
		platform.setupAvailable().then(
			(r) => live && setSetupOpen(r.available),
			() => {}
		);
		return () => {
			live = false;
		};
	}, []);

	if (!isStaffTokenExpired(token)) return <Navigate to={returnTo} replace />;
	if (next)
		return (
			<MfaStep
				stage={next.stage}
				pendingToken={next.pendingToken}
				returnTo={returnTo}
			/>
		);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setNext(await platform.login(email, password));
		} catch (err) {
			setError(platformError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthCard title="Sign in">
			<form onSubmit={submit} className="space-y-4">
				{notice === "expired" && !error && (
					<p
						role="status"
						className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text"
					>
						Your session ended. Sign in again to continue; a
						change you were saving may not have been applied, so
						check its History.
					</p>
				)}
				{error && <FormErrorBanner message={error} />}
				<div>
					<label htmlFor="pf-email" className={labelClass}>
						Email
					</label>
					<input
						id="pf-email"
						type="email"
						autoComplete="username"
						className={inputClass}
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
				</div>
				<div>
					<label htmlFor="pf-password" className={labelClass}>
						Password
					</label>
					<PasswordInput
						id="pf-password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
				</div>
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={busy}
				>
					Sign in
				</button>
				<p className="text-xs text-text-tertiary">
					Locked out? Ask another staff member to reset your MFA.
				</p>
				{setupOpen && (
					<p className="text-xs text-text-tertiary">
						No staff account yet?{" "}
						<Link
							to="/platform/setup"
							className="text-primary hover:underline"
						>
							Set up the back office
						</Link>
					</p>
				)}
			</form>
		</AuthCard>
	);
}
