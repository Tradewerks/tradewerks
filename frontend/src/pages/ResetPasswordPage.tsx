import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { resetPasswordCall } from "../api/authenticate";
import { useAuthStore } from "../auth/authStore";
import { passwordProblem } from "../lib/passwordRules";

export default function ResetPasswordPage() {
	const { login } = useAuthStore();
	const [searchParams] = useSearchParams();
	const [status, setStatus] = useState<"input" | "loading" | "success" | "error">("input");
	const navigate = useNavigate();
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [errorMessage, setErrorMessage] = useState("");

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		const problem = passwordProblem(newPassword, confirmPassword);
		if (problem) { setErrorMessage(problem); return; }

		const token = searchParams.get("token");
		const role = searchParams.get("role");
		if (!token || !role) { setStatus("error"); return; }

		setStatus("loading");
		try {
			const result = await resetPasswordCall(token, newPassword, role);
			const parts = result.token.split(".");
			const payload = JSON.parse(atob(parts[1]));
			const orgTimezone = payload.organization_timezone ?? "America/Chicago";
			login(payload.role, payload.email, payload.uid, payload.organization_id ?? null, orgTimezone, payload.permissions ?? []);
			navigate(payload.role === "technician" ? "/technician" : "/dispatch");
		} catch {
			setStatus("error");
		}
	};

	const inputClass = "w-full border border-zinc-300 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 transition-colors";
	const labelClass = "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1";

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center">
			<div className="bg-white rounded-lg shadow-md border border-zinc-200 p-8 w-80 text-center">

				{status === "input" && (
					<form onSubmit={handleSubmit} className="text-left">
						<h2 className="text-xl font-semibold text-zinc-900 mb-2 text-center">Reset Password</h2>
						<p className="text-zinc-500 text-sm mb-6 text-center">Enter your new password below.</p>

						<div className="mb-4">
							<label className={labelClass}>New Password</label>
							<input
								type="password"
								value={newPassword}
								onChange={(e) => { setNewPassword(e.target.value); setErrorMessage(""); }}
								className={inputClass}
								placeholder="Min. 8 characters"
								required
							/>
						</div>

						<div className="mb-4">
							<label className={labelClass}>Confirm Password</label>
							<input
								type="password"
								value={confirmPassword}
								onChange={(e) => { setConfirmPassword(e.target.value); setErrorMessage(""); }}
								className={inputClass}
								placeholder="Repeat new password"
								required
							/>
						</div>

						{errorMessage && <p className="text-red-600 text-sm mb-4">{errorMessage}</p>}

						<button
							type="submit"
							className="w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2 rounded-lg transition-colors"
						>
							Reset Password
						</button>
					</form>
				)}

				{status === "loading" && (
					<>
						<div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
						<h2 className="text-xl font-semibold text-zinc-900">Resetting password...</h2>
						<p className="text-zinc-500 mt-2 text-sm">Please wait a moment.</p>
					</>
				)}

				{status === "success" && (
					<>
						<div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
							<svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
							</svg>
						</div>
						<h2 className="text-xl font-semibold text-zinc-900">Password Reset!</h2>
						<p className="text-zinc-500 mt-2 text-sm">Redirecting you to login in 3 seconds...</p>
					</>
				)}

				{status === "error" && (
					<>
						<div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
							<svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</div>
						<h2 className="text-xl font-semibold text-zinc-900">Reset Failed</h2>
						<p className="text-zinc-500 mt-2 text-sm">This link is invalid or has expired.</p>
						<button
							onClick={() => navigate("/login")}
							className="mt-6 w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2 rounded-lg transition-colors"
						>
							Back to Login
						</button>
					</>
				)}

			</div>
		</div>
	);
}
