import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { checkResetTokenCall, resetPasswordCall } from "../api/authenticate";
import { useAuthStore } from "../auth/authStore";
import { Circle, CircleCheck, Clock } from "lucide-react";

export default function ResetPasswordPage() {
	const { login } = useAuthStore();
	const [searchParams] = useSearchParams();
	const token = searchParams.get("token");
	const role = searchParams.get("role");
	const [status, setStatus] = useState<"checking" | "input" | "loading" | "expired" | "invalid">("checking");
	const navigate = useNavigate();
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [errorMessage, setErrorMessage] = useState("");

	const checkToken = useCallback(() => {
		if (!token || !role) {
			setStatus("invalid");
			return;
		}
		checkResetTokenCall(token, role)
			.then((s) => setStatus(s === "valid" ? "input" : s))
			.catch(() => setStatus("invalid"));
	}, [token, role]);

	useEffect(checkToken, [checkToken]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (newPassword !== confirmPassword) { setErrorMessage("Passwords do not match"); return; }
		if (newPassword.length < 8) { setErrorMessage("Password must be at least 8 characters"); return; }
		if (!/[A-Z]/.test(newPassword)) { setErrorMessage("Password must contain at least one capital letter"); return; }
		if (!/[0-9]/.test(newPassword)) { setErrorMessage("Password must contain at least one number"); return; }
		if (!/[^A-Za-z0-9]/.test(newPassword)) { setErrorMessage("Password must contain at least one special character"); return; }

		if (!token || !role) { setStatus("invalid"); return; }

		setStatus("loading");
		try {
			const result = await resetPasswordCall(token, newPassword, role);
			const parts = result.token.split(".");
			const payload = JSON.parse(atob(parts[1]));
			const orgTimezone = payload.organization_timezone ?? "America/Chicago";
			login(payload.role, payload.email, payload.uid, payload.organization_id ?? null, orgTimezone, payload.permissions ?? []);
			navigate(payload.role === "technician" ? "/technician" : "/dispatch");
		} catch (err) {
			const message = axios.isAxiosError(err) ? err.response?.data?.error?.message : undefined;
			if (message === "Invalid or expired token") {
				checkToken();
				return;
			}
			setErrorMessage(message || "Something went wrong. Please try again.");
			setStatus("input");
		}
	};

	const inputClass = "w-full border border-zinc-300 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 transition-colors";
	const labelClass = "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1";

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center">
			<div className="bg-white rounded-lg shadow-md border border-zinc-200 p-8 w-96 text-center">

				{status === "checking" && (
					<div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
				)}

				{status === "input" && (
					<form onSubmit={handleSubmit} className="text-left">
						<h2 className="text-xl font-semibold text-zinc-900 mb-2 text-center">Reset Password</h2>
						<p className="text-zinc-500 text-sm mb-6 text-center">Enter your new password below</p>

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
						<div className="grid grid-cols-2 mb-4 text-xs text-text-muted">
							<div>
								<span className="flex gap-1">
									{newPassword.length >= 8 
										? <CircleCheck size={12} color="green"/>
										: <Circle size={12} />
									}
									At least 8 characters
								</span>
								<span className="flex gap-1"> 
									{/[A-Z]/.test(newPassword)
										? <CircleCheck size={12} color="green"/>
										: <Circle size={12} />
									}
									One capital letter
								</span>
							</div>
							<div>
								<span className="flex gap-1">
									{/[0-9]/.test(newPassword)
										? <CircleCheck size={12} color="green"/>
										: <Circle size={12} />
									}
									One number
								</span>
								<span className="flex gap-1">
									{/[^A-Za-z0-9]/.test(newPassword)
										? <CircleCheck size={12} color="green"/>
										: <Circle size={12} />
									}
									One special character
								</span>
							</div>
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
						<p className="text-zinc-500 mt-2 text-sm">Please wait a moment</p>
					</>
				)}

				{(status === "expired" || status === "invalid") && (
					<>
						<div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
							<Clock className="w-7 h-7 text-amber-700" />
						</div>
						<h2 className="text-xl font-semibold text-zinc-900">
							{status === "expired" ? "This link has expired" : "This link is no longer valid"}
						</h2>
						<p className="text-zinc-500 mt-2 text-sm">
							{status === "expired" ? "Reset links expire after 1 hour." : "It may have already been used."}{" "}
							Ask your administrator to send you a new one
						</p>
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
