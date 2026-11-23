import { useState } from "react";
import { isAxiosError } from "axios";
import {
	setPublicConsent,
	type ConsentState,
	type UnsubscribeLinkData,
} from "../../api/publicLinks";
import { brandButtonStyle, primaryButtonClass } from "./publicStyles";

interface Props {
	token: string;
	data: UnsubscribeLinkData;
}

export default function UnsubscribeView({ token, data }: Props) {
	const [state, setState] = useState({ email: data.email, sms: data.sms });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const change = async (channel: "email" | "sms", status: ConsentState) => {
		setBusy(true);
		setError("");
		try {
			setState(await setPublicConsent(token, channel, status));
		} catch (err) {
			setError(
				(isAxiosError(err) && err.response?.data?.error?.message) ||
					"Could not save your choice. Try again."
			);
		} finally {
			setBusy(false);
		}
	};

	const unsubscribed = state.email === "unsubscribed";
	return (
		<div className="space-y-5 text-center">
			<h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
				Email preferences
			</h1>
			{data.contact_email_masked && (
				<p className="text-sm text-zinc-600 dark:text-zinc-400">
					{data.contact_email_masked}
				</p>
			)}
			{unsubscribed ? (
				<>
					<p
						role="status"
						className="text-sm text-zinc-700 dark:text-zinc-300"
					>
						You are unsubscribed and will not get these emails
						from {data.org.name}.
					</p>
					<button
						type="button"
						disabled={busy}
						onClick={() => change("email", "subscribed")}
						className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
					>
						Resubscribe
					</button>
				</>
			) : (
				<>
					<p className="text-sm text-zinc-700 dark:text-zinc-300">
						You are subscribed to emails from {data.org.name}.
					</p>
					<button
						type="button"
						disabled={busy}
						onClick={() => change("email", "unsubscribed")}
						style={brandButtonStyle(data.org)}
						className={primaryButtonClass}
					>
						Unsubscribe
					</button>
				</>
			)}
			{state.sms === "subscribed" && (
				<button
					type="button"
					disabled={busy}
					onClick={() => change("sms", "unsubscribed")}
					className="block min-h-11 w-full text-sm text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
				>
					Stop text messages too
				</button>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600 dark:text-red-400">
					{error}
				</p>
			)}
			{(data.org.phone || data.org.email) && (
				<p className="text-xs text-zinc-500">
					Questions?{" "}
					{[data.org.phone, data.org.email]
						.filter(Boolean)
						.join(" / ")}
				</p>
			)}
		</div>
	);
}
