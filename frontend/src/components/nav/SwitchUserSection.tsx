import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Loader2, UserRound, UserRoundPlus, Users } from "lucide-react";
import { clearSessionStorage, useAuthStore } from "../../auth/authStore";
import { queryClient } from "../../lib/queryClient";
import { APP_BASE } from "../../config";
import { logoutBeacon } from "../../api/authenticate";
import {
	useRememberedAccountsStore,
	type RememberedAccount,
} from "../../stores/rememberedAccountsStore";

export default function SwitchUserSection() {
	const { user, logout } = useAuthStore();
	const accounts = useRememberedAccountsStore((s) => s.accounts);
	const removeAccount = useRememberedAccountsStore((s) => s.removeAccount);
	const [open, setOpen] = useState(false);
	const [switching, setSwitching] = useState(false);
	const navigate = useNavigate();
	const otherAccounts = accounts.filter((a) => a.userId !== user?.userId);

	const switchTo = (account: RememberedAccount) => {
		setSwitching(true);
		logoutBeacon();
		clearSessionStorage();
		// Not logout(): clearing the user re-renders RequireAuth, which would redirect to a
		// bare /login and drop the ?email= this page load carries.
		useAuthStore.persist.clearStorage();
		window.location.replace(`${APP_BASE}/login?email=${encodeURIComponent(account.email)}`);
	};

	const signInAsNew = () => {
		logoutBeacon();
		logout(true);
		queryClient.clear();
		navigate("/login");
	};

	return (
		<div className="p-2 flex flex-col">
			<button
				onClick={() => (otherAccounts.length > 0 ? setOpen(!open) : signInAsNew())}
				aria-expanded={otherAccounts.length > 0 ? open : undefined}
				className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
			>
				<Users size={16} />
				Switch User
				{otherAccounts.length > 0 && (
					<ChevronDown
						size={13}
						className={`ml-auto transition-transform duration-200 ${open ? "rotate-180" : ""}`}
					/>
				)}
			</button>
			{open && otherAccounts.length > 0 && (
				<div className="flex flex-col pb-0.5">
					{otherAccounts.map((account) => (
						<div
							key={account.userId}
							className="flex items-center rounded-md hover:bg-surface transition-colors"
						>
							<button
								onClick={() => switchTo(account)}
								title={account.email}
								className="min-w-0 flex-1 flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm text-left text-text-primary"
							>
								<UserRound size={14} className="shrink-0" />
								<span className="min-w-0">
									<span className="block truncate">{account.email}</span>
									{account.orgName && (
										<span className="block text-xs text-text-muted truncate">
											{account.orgName}
										</span>
									)}
								</span>
							</button>
							<button
								onClick={() => removeAccount(account.userId)}
								aria-label={`Remove ${account.email}`}
								className="mr-2 shrink-0 text-error hover:text-error-hover transition-colors hover:bg-error-bg rounded-sm w-5 h-5 flex items-center justify-center"
							>
								&times;
							</button>
						</div>
					))}
					<button
						onClick={signInAsNew}
						className="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-sm rounded-md text-text-primary hover:text-text-primary hover:bg-surface transition-colors"
					>
						<UserRoundPlus size={14} className="shrink-0" />
						New User
					</button>
				</div>
			)}
			{/* Portaled out of the menu panel's z-50 stacking context. */}
			{switching &&
				createPortal(
					<div className="fixed inset-0 z-[6000] flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-sm">
						<Loader2 className="w-10 h-10 animate-spin text-primary" />
						<p className="text-sm text-text-primary">Switching account</p>
					</div>,
					document.body,
				)}
		</div>
	);
}
