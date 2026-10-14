import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useNavigate } from "react-router-dom";
import { platform, platformError } from "../api";
import { usePlatformAuth } from "../store";
import { AuthCard, inputClass, primaryButtonClass } from "./AuthCard";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import type { StaffSession } from "../types";

const secondaryButton =
	"h-9 flex-1 rounded-md border border-border text-sm text-text-primary transition-colors duration-150 ease-out hover:bg-surface-inset";

function downloadCodes(codes: string[]) {
	const blob = new Blob(
		[
			`TradeWerks back office recovery codes\nEach code signs you in once.\n\n${codes.join("\n")}\n`,
		],
		{ type: "text/plain" }
	);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "tradewerks-recovery-codes.txt";
	a.click();
	URL.revokeObjectURL(url);
}

export default function MfaStep({
	stage,
	pendingToken,
	returnTo = "/platform/orgs",
}: {
	stage: "mfa" | "enroll";
	pendingToken: string;
	returnTo?: string;
}) {
	const signIn = usePlatformAuth((s) => s.signIn);
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const [useRecovery, setUseRecovery] = useState(false);
	const [enroll, setEnroll] = useState<{ otpAuthUri: string; secret: string } | null>(null);
	const [saved, setSaved] = useState<{ codes: string[]; session: StaffSession } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [stored, setStored] = useState(false);

	// Leaving before the codes are stored loses them for good: they are shown only once.
	useEffect(() => {
		if (!saved) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [saved]);

	useEffect(() => {
		if (stage !== "enroll") return;
		platform.enrollStart(pendingToken).then(setEnroll, (e) =>
			setError(platformError(e))
		);
	}, [stage, pendingToken]);

	const finish = (s: StaffSession) => {
		signIn(s.token, s.staff);
		navigate(returnTo, { replace: true });
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (stage === "mfa") {
				finish(
					await platform.verifyMfa(
						pendingToken,
						useRecovery ? { recoveryCode: code } : { code }
					)
				);
			} else {
				const r = await platform.enrollFinish(pendingToken, code);
				setSaved({
					codes: r.recoveryCodes,
					session: { token: r.token, staff: r.staff },
				});
			}
		} catch (err) {
			setError(platformError(err));
		} finally {
			setBusy(false);
		}
	};

	if (saved)
		return (
			<AuthCard title="Save your recovery codes">
				<p className="text-sm text-text-secondary">
					If you lose access to your authenticator app, each code
					signs you in once. Keep them apart from the app, for example
					in a password manager. They are shown only now.
				</p>
				<div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface-inset p-3 font-mono text-sm text-text-primary">
					{saved.codes.map((c) => (
						<span key={c} className="text-center">
							{c}
						</span>
					))}
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						className={secondaryButton}
						onClick={() =>
							void navigator.clipboard.writeText(
								saved.codes.join("\n")
							)
						}
					>
						Copy
					</button>
					<button
						type="button"
						className={secondaryButton}
						onClick={() => downloadCodes(saved.codes)}
					>
						Download
					</button>
				</div>
				<label className="flex items-start gap-2 text-sm text-text-secondary">
					<input
						type="checkbox"
						className="mt-0.5"
						checked={stored}
						onChange={(e) => setStored(e.target.checked)}
					/>
					I've saved my recovery codes.
				</label>
				<button
					type="button"
					className={primaryButtonClass}
					disabled={!stored}
					onClick={() => finish(saved.session)}
				>
					Continue
				</button>
			</AuthCard>
		);

	return (
		<AuthCard
			title={
				stage === "enroll"
					? "Set up two-factor sign-in"
					: "Two-factor sign-in"
			}
		>
			<form onSubmit={submit} className="space-y-4">
				{error && <FormErrorBanner message={error} />}
				{stage === "enroll" && enroll && (
					<div className="space-y-2">
						<p className="text-sm text-text-secondary">
							Scan with your authenticator app, then enter
							the 6-digit code.
						</p>
						{/* White tile so phone cameras can read the code on the dark surface. */}
						<div className="flex justify-center rounded-md bg-white p-3">
							<QRCodeSVG
								value={enroll.otpAuthUri}
								size={160}
							/>
						</div>
						<code className="block break-all rounded-md border border-border bg-surface-inset px-3 py-2 text-center font-mono text-xs text-text-secondary">
							{enroll.secret}
						</code>
					</div>
				)}
				<input
					className={inputClass}
					autoFocus
					autoComplete="one-time-code"
					inputMode={useRecovery ? "text" : "numeric"}
					aria-label={
						useRecovery
							? "Recovery code"
							: "Authentication code"
					}
					placeholder={useRecovery ? "Recovery code" : "6-digit code"}
					value={code}
					onChange={(e) => setCode(e.target.value.trim())}
				/>
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={busy || !code}
				>
					{stage === "enroll" ? "Turn on and continue" : "Verify"}
				</button>
				{stage === "mfa" && (
					<button
						type="button"
						className="w-full text-sm text-primary hover:underline"
						onClick={() => {
							setUseRecovery((v) => !v);
							setCode("");
						}}
					>
						{useRecovery
							? "Use authenticator code"
							: "Use a recovery code"}
					</button>
				)}
			</form>
		</AuthCard>
	);
}
