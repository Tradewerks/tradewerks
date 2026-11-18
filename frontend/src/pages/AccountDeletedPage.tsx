import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useAuthStore } from "../auth/authStore";
import { LEGAL } from "../components/landing/legal/legal";
import type { AccountDeletedState } from "../components/profile/DeleteAccountCard";

// Where the app lands after someone deletes their account. Public: they are
// already signed out by the time it renders.
export default function AccountDeletedPage() {
	const state = useLocation().state as AccountDeletedState | null;
	const logout = useAuthStore((s) => s.logout);
	const queryClient = useQueryClient();
	const org = state?.kind === "organization";

	// Arriving from a deletion: drop the local session and every cached query.
	useEffect(() => {
		if (!state) return;
		logout();
		queryClient.clear();
	}, [state, logout, queryClient]);
	const orgName = state?.orgName || "Your organization";

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-4">
			<div className="bg-white rounded-2xl shadow-md border border-zinc-200 p-10 max-w-md w-full text-center space-y-4">
				<div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto">
					<CheckCircle2 size={28} className="text-green-600" aria-hidden />
				</div>
				<h1 className="text-xl font-semibold text-zinc-900">
					{org ? `${orgName} is being deleted` : "Your account was deleted"}
				</h1>
				{org ? (
					<>
						<p className="text-sm text-zinc-600">
							Everyone in {orgName} has been signed out. We're permanently deleting the organization's
							data now, which usually takes a few minutes.
						</p>
						<p className="text-sm text-zinc-600">We'll email you when it's done.</p>
					</>
				) : (
					<p className="text-sm text-zinc-600">
						Your personal information was removed and you've been signed out everywhere. A confirmation is on
						its way to your email.
					</p>
				)}
				<p className="text-sm text-zinc-500">
					Questions?{" "}
					<a href={`mailto:${LEGAL.privacyEmail}`} className="text-blue-600 hover:underline">
						{LEGAL.privacyEmail}
					</a>
				</p>
				{/* Outside the app's router basename: the public site. */}
				<a href="/" className="block text-sm text-blue-600 hover:underline">
					Go to the {LEGAL.company} home page
				</a>
			</div>
		</div>
	);
}
