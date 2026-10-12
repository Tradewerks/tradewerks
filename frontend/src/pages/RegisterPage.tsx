import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { isAxiosError } from "axios";
import { registerOrganization } from "../api/organizations";
import { useBusinessTypes } from "../hooks/useBusinessTypes";
import { passwordProblem } from "../lib/passwordRules";

type Status = "input" | "loading" | "success" | "error" | "paused";

export default function RegisterPage() {
	const navigate = useNavigate();
	const [status, setStatus] = useState<Status>("input");
	const [errorMessage, setErrorMessage] = useState("");

	const [orgName, setOrgName] = useState("");
	const [orgPhone, setOrgPhone] = useState("");
	const [orgAddress, setOrgAddress] = useState("");
	const [orgWebsite, setOrgWebsite] = useState("");
	const [orgTimezone, setOrgTimezone] = useState("America/Chicago");
	const [adminName, setAdminName] = useState("");
	const [adminEmail, setAdminEmail] = useState("");
	const [adminPhone, setAdminPhone] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [businessType, setBusinessType] = useState("");
	const types = useBusinessTypes();

	const validate = (): string | null => {
		if (!orgName.trim()) return "Organization name is required.";
		if (!adminName.trim()) return "Your name is required.";
		if (!businessType) return "Choose what kind of business you are.";
		const pw = passwordProblem(password, confirmPassword);
		if (pw) return pw;
		return null;
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const err = validate();
		if (err) { setErrorMessage(err); return; }

		setStatus("loading");
		try {
			await registerOrganization({
				org_name: orgName.trim(),
				admin_name: adminName.trim(),
				admin_email: adminEmail.trim(),
				admin_password: password,
				business_type: businessType,
				admin_phone: adminPhone.trim() || undefined,
				org_phone: orgPhone.trim() || undefined,
				org_address: orgAddress.trim() || undefined,
				org_website: orgWebsite.trim() || undefined,
				org_timezone: orgTimezone || undefined,
			});
			setStatus("success");
		} catch (e) {
			if (isAxiosError(e) && e.response?.data?.error?.code === "SIGNUPS_PAUSED") {
				setStatus("paused");
				return;
			}
			setErrorMessage(
				(isAxiosError(e) && e.response?.data?.error?.message) ||
					(e instanceof Error && e.message) ||
					"Registration failed.",
			);
			setStatus("error");
		}
	};

	const inputClass = "w-full border border-zinc-300 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 transition-colors";

	const field = (
		label: string,
		type: string,
		value: string,
		onChange: (v: string) => void,
		placeholder?: string,
		required = true
	) => {
		const id = `reg-${label.toLowerCase().replace(/\W+/g, "-")}`;
		return (
			<div>
				<label htmlFor={id} className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">
					{label}
					{!required && <span className="ml-1 text-zinc-400 normal-case">(optional)</span>}
				</label>
				<input
					id={id}
					type={type}
					value={value}
					onChange={(e) => { onChange(e.target.value); setErrorMessage(""); }}
					placeholder={placeholder}
					required={required}
					className={inputClass}
				/>
			</div>
		);
	};

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-4">
			<div className="bg-white rounded-2xl shadow-md border border-zinc-200 p-10 max-w-md w-full">
				{status === "input" && (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="text-center mb-2">
							<h1 className="text-2xl font-semibold text-zinc-900">Create your account</h1>
							<p className="text-zinc-500 text-sm mt-1">Set up your organization and admin account.</p>
						</div>

						<p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider pt-2">Organization</p>
						{field("Organization Name", "text", orgName, setOrgName, "e.g. Acme HVAC")}
						<div>
							<label htmlFor="reg-business-type" className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">
								What kind of business are you?
							</label>
							<select
								id="reg-business-type"
								required
								value={businessType}
								onChange={(e) => { setBusinessType(e.target.value); setErrorMessage(""); }}
								className={inputClass}
								disabled={!types.data}
							>
								<option value="" disabled>
									{types.isError ? "Could not load — reload the page" : "Choose one"}
								</option>
								{types.data?.map((t) => (
									<option key={t.key} value={t.key}>{t.label}</option>
								))}
							</select>
						</div>
						{field("Organization Phone", "tel", orgPhone, setOrgPhone, "+1 (555) 000-0000", false)}
						{field("Address", "text", orgAddress, setOrgAddress, "123 Main St, Chicago, IL", false)}
						{field("Website", "url", orgWebsite, setOrgWebsite, "https://example.com", false)}
						<div>
							<label htmlFor="reg-timezone" className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">
								Timezone
								<span className="ml-1 text-zinc-400 normal-case">(optional)</span>
							</label>
							<select
								id="reg-timezone"
								value={orgTimezone}
								onChange={(e) => setOrgTimezone(e.target.value)}
								className={inputClass}
							>
								<option value="America/New_York">Eastern (ET)</option>
								<option value="America/Chicago">Central (CT)</option>
								<option value="America/Denver">Mountain (MT)</option>
								<option value="America/Los_Angeles">Pacific (PT)</option>
								<option value="America/Anchorage">Alaska (AKT)</option>
								<option value="Pacific/Honolulu">Hawaii (HT)</option>
								<option value="America/Phoenix">Arizona (no DST)</option>
								<option value="America/Puerto_Rico">Puerto Rico (AST)</option>
							</select>
						</div>

						<p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider pt-2">Admin Account</p>
						{field("Your Name", "text", adminName, setAdminName, "Full name")}
						{field("Email", "email", adminEmail, setAdminEmail, "you@company.com")}
						{field("Phone", "tel", adminPhone, setAdminPhone, "+1 (555) 000-0000", false)}
						{field("Password", "password", password, setPassword, "Min. 8 characters")}
						{field("Confirm Password", "password", confirmPassword, setConfirmPassword, "Repeat password")}

						{errorMessage && <p className="text-red-600 text-sm">{errorMessage}</p>}

						<button
							type="submit"
							className="w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2 rounded-lg transition-colors mt-2"
						>
							Create Account
						</button>

						<p className="text-sm text-zinc-500 text-center">
							Already have an account?{" "}
							<Link to="/login" className="text-blue-600 hover:underline">Sign in</Link>
						</p>
					</form>
				)}

				{status === "loading" && (
					<div className="text-center py-6">
						<div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
						<h2 className="text-xl font-semibold text-zinc-900">Setting up your account...</h2>
						<p className="text-zinc-500 mt-2 text-sm">Just a moment.</p>
					</div>
				)}

				{status === "success" && (
					<div className="text-center py-6">
						<div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
							<svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
							</svg>
						</div>
						<h2 className="text-xl font-semibold text-zinc-900">Account Created!</h2>
						<p className="text-zinc-500 mt-2 text-sm">
							Email verification is temporarily disabled while we await sender approval. You can sign in directly.
						</p>
						<button
							onClick={() => navigate("/login")}
							className="mt-6 w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2 rounded-lg transition-colors"
						>
							Go to Login
						</button>
					</div>
				)}

				{status === "paused" && (
					<div className="text-center py-6 space-y-3">
						<h1 className="text-2xl font-semibold text-zinc-900">Signups are paused</h1>
						<p className="text-sm text-zinc-600">Signups are paused. Contact TradeWerks.</p>
						<Link to="/login" className="text-sm text-blue-600 hover:underline">Back to sign in</Link>
					</div>
				)}

				{status === "error" && (
					<div className="text-center py-6">
						<div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
							<svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</div>
						<h2 className="text-xl font-semibold text-zinc-900">Registration Failed</h2>
						<p className="text-zinc-500 mt-2 text-sm">{errorMessage}</p>
						<button
							onClick={() => { setStatus("input"); setErrorMessage(""); }}
							className="mt-6 w-full bg-primary hover:bg-primary-hover text-on-primary font-medium py-2 rounded-lg transition-colors"
						>
							Try Again
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
