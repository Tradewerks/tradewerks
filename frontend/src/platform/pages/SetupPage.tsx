import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { platform, platformError } from "../api";
import {
	AuthCard,
	inputClass,
	labelClass,
	PasswordInput,
	primaryButtonClass,
} from "../components/AuthCard";
import MfaStep from "../components/MfaStep";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";

export default function SetupPage() {
	const [available, setAvailable] = useState<boolean | null>(null);
	const [form, setForm] = useState({ code: "", name: "", email: "", password: "" });
	const [pendingToken, setPendingToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		platform.setupAvailable().then(
			(r) => setAvailable(r.available),
			(e) => {
				setAvailable(true);
				setError(platformError(e));
			}
		);
	}, []);

	if (pendingToken) return <MfaStep stage="enroll" pendingToken={pendingToken} />;

	if (available === null)
		return (
			<AuthCard title="Set up the back office">
				<div className="h-9 animate-pulse rounded-md bg-surface-inset" />
			</AuthCard>
		);

	if (!available)
		return (
			<AuthCard title="Setup is not available">
				<Link
					to="/platform/login"
					className="text-sm text-primary hover:underline"
				>
					Go to sign in
				</Link>
			</AuthCard>
		);

	const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
		setForm((f) => ({ ...f, [k]: e.target.value }));

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setPendingToken((await platform.setup(form)).pendingToken);
		} catch (err) {
			setError(platformError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthCard title="Set up the back office">
			<form onSubmit={submit} className="space-y-4">
				{error && <FormErrorBanner message={error} />}
				<div>
					<label htmlFor="pf-code" className={labelClass}>
						Setup code
					</label>
					<input
						id="pf-code"
						className={inputClass}
						autoComplete="off"
						value={form.code}
						onChange={set("code")}
						required
					/>
				</div>
				<div>
					<label htmlFor="pf-name" className={labelClass}>
						Your name
					</label>
					<input
						id="pf-name"
						className={inputClass}
						autoComplete="name"
						value={form.name}
						onChange={set("name")}
						required
					/>
				</div>
				<div>
					<label htmlFor="pf-email" className={labelClass}>
						Email
					</label>
					<input
						id="pf-email"
						type="email"
						className={inputClass}
						autoComplete="username"
						value={form.email}
						onChange={set("email")}
						required
					/>
				</div>
				<div>
					<label htmlFor="pf-password" className={labelClass}>
						Password
					</label>
					<PasswordInput
						id="pf-password"
						autoComplete="new-password"
						value={form.password}
						onChange={set("password")}
						minLength={12}
						required
					/>
					<p className="mt-1 text-xs text-text-tertiary">
						12 characters or more
					</p>
				</div>
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={busy}
				>
					Create account
				</button>
			</form>
		</AuthCard>
	);
}
