import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { acceptOrgInvite, previewOrgInvite } from "../api/organizations";
import { passwordProblem } from "../lib/passwordRules";

const inputClass = "w-full border border-zinc-300 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 transition-colors";
const labelClass = "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1";
const EXPIRED = "This invite expired. Ask TradeWerks to resend it.";

export default function AcceptInvitePage() {
	const [params] = useSearchParams();
	const token = params.get("token") ?? "";
	const navigate = useNavigate();
	const preview = useQuery({
		queryKey: ["org-invite", token],
		queryFn: () => previewOrgInvite(token),
		enabled: token.length >= 20,
		retry: false,
	});
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const problem = passwordProblem(password, confirm);
		if (problem) return setError(problem);
		setBusy(true);
		try {
			const { email } = await acceptOrgInvite(token, password);
			navigate(`/login?email=${encodeURIComponent(email)}`, { replace: true });
		} catch (err) {
			if (isAxiosError(err) && err.response?.status === 404) setError(EXPIRED);
			else
				setError(
					(isAxiosError(err) && err.response?.data?.error?.message) ||
						"Could not set your password. Try again.",
				);
		} finally {
			setBusy(false);
		}
	};

	// Only a 404 means the link is dead; a 429, 5xx or network failure says nothing about it.
	const previewErr = preview.error;
	const invalid =
		token.length < 20 || (isAxiosError(previewErr) && previewErr.response?.status === 404);
	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-4">
			<div className="bg-white rounded-2xl shadow-md border border-zinc-200 p-10 max-w-md w-full">
				{invalid ? (
					<div className="space-y-3 text-center">
						<h1 className="text-2xl font-semibold text-zinc-900">Invite link</h1>
						<p className="text-sm text-zinc-600">{EXPIRED}</p>
						<Link to="/login" className="text-sm text-blue-600 hover:underline">
							Go to sign in
						</Link>
					</div>
				) : previewErr ? (
					<div className="space-y-3 text-center">
						<h1 className="text-2xl font-semibold text-zinc-900">Invite link</h1>
						<p role="alert" className="text-sm text-zinc-600">
							{(isAxiosError(previewErr) && previewErr.response?.data?.error?.message) ||
								"Could not check this invite. Try again."}
						</p>
						<button
							type="button"
							onClick={() => preview.refetch()}
							disabled={preview.isFetching}
							className="text-sm text-blue-600 hover:underline disabled:opacity-50"
						>
							Try again
						</button>
					</div>
				) : !preview.data ? (
					<div className="h-40 animate-pulse rounded-lg bg-zinc-100" aria-busy="true" />
				) : (
					<form onSubmit={submit} className="space-y-4">
						<div className="text-center mb-2">
							<h1 className="text-2xl font-semibold text-zinc-900">Welcome to {preview.data.company}</h1>
							<p className="text-zinc-500 text-sm mt-1">Set a password for {preview.data.email}.</p>
						</div>
						<div>
							<label htmlFor="inv-password" className={labelClass}>Password</label>
							<input
								id="inv-password"
								type="password"
								autoComplete="new-password"
								className={inputClass}
								value={password}
								onChange={(e) => { setPassword(e.target.value); setError(""); }}
								required
							/>
						</div>
						<div>
							<label htmlFor="inv-confirm" className={labelClass}>Confirm password</label>
							<input
								id="inv-confirm"
								type="password"
								autoComplete="new-password"
								className={inputClass}
								value={confirm}
								onChange={(e) => { setConfirm(e.target.value); setError(""); }}
								required
							/>
						</div>
						{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
						<button
							type="submit"
							disabled={busy}
							className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
						>
							Set password
						</button>
					</form>
				)}
			</div>
		</div>
	);
}
