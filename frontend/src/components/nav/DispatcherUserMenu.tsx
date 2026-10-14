import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../auth/authStore";
import { queryClient } from "../../lib/queryClient";
import { APP_BASE } from "../../config";
import { LogOut, UserRound, Sun, Moon, Monitor, Palette, ChevronDown, Check, Users, UserRoundPlus, Loader2 } from "lucide-react";
import { useOrgSettings } from "../../hooks/useOrg";
import { useThemeStore } from "../../stores/themeStore";
import { useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import { useRememberedAccountsStore } from "../../stores/rememberedAccountsStore";
import { logoutBeacon } from "../../api/authenticate";

export default function DispatcherUserMenu() {
	const { user, logout } = useAuthStore();
	const [menuOpen, setMenuOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [switchUserOpen, setSwitchUserOpen] = useState(false);
	const {accounts, patchAccount, removeAccount} = useRememberedAccountsStore();
	const [accountSwitching, setAccountSwitching] = useState(false);
	const otherAccounts = accounts.filter((a) => a.userId !== user?.userId);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const navigate = useNavigate();
	const { data: org } = useOrgSettings(); // possibly add org logo to the menu in the future
	const { theme, setTheme } = useThemeStore();
	const updateDispatcherMutation = useUpdateDispatcherMutation();

	const handleThemeChange = (value: "system" | "light" | "dark") => {
		setTheme(value);
		if (user?.userId) {
			updateDispatcherMutation.mutate({ id: user.userId, data: { theme: value } });
		}
	};

	const handleLogout = () => {
		logoutBeacon();
		logout();
		queryClient.clear();
		navigate("/login");
	};

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	useEffect(() => {
		if (user?.userId && org?.name) {
			patchAccount(user.userId, { orgName: org.name });
		}
	}, [user?.userId, org?.name]);

	return (
		<div ref={wrapperRef} className="relative">
			<button
				onClick={() => setMenuOpen((o) => !o)}
				/* Underline carries interaction state only — closed, hovered, open — so
				   it runs on one accent at two weights rather than a grey. It was
				   `border-border` on hover against a `border-strong` fill: both from
				   the border family, and the hover landed darker than the fill in dark
				   mode but lighter in light mode, so the accent had no consistent
				   direction. Fill moved to the avatar tokens for the same reason it
				   did on the dashboard badge. */
				className={`w-9 h-9 rounded-lg bg-avatar-bg flex items-center justify-center pt-[3px] text-avatar-fg font-semibold text-sm border-b-[3px] transition-colors ${
					menuOpen ? "border-primary" : "border-transparent hover:border-primary/40"
				}`}
			>
				{user?.name.charAt(0).toUpperCase()}
			</button>

			{menuOpen && (
				<div className="absolute top-full right-0 mt-2 w-54 bg-surface-raised border border-border-subtle rounded-lg shadow-lg z-50 overflow-hidden">
					<div className="px-4 py-3 border-b border-border-subtle flex items-start gap-3">
						<span className="w-10 h-10 shrink-0 rounded-lg bg-avatar-bg flex items-center justify-center text-avatar-fg font-semibold text-sm">
							{user?.name.charAt(0).toUpperCase()}
						</span>
						<div className="min-w-0">
							<p className="text-sm font-semibold text-text-primary truncate">
								{user?.name.split("@")[0]}
							</p>
							<p className="text-xs text-text-muted truncate">{user?.name}</p>
							<p className="text-xs text-text-muted capitalize mt-0.5">{user?.role}</p>
							{org?.name && (
								<p className="text-xs text-text-muted truncate mt-0.5">{org.name}</p>
							)}
							
						</div>
					</div>

                    <div className="my-.25 border-t border-subtle" />
                    <div className="p-2 flex flex-col">
                        <button
                            className="w-full flex items-center gap-1 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
                            onClick={() => { navigate("/dispatch/profile"); setMenuOpen(false); }}
                        >
                            <UserRound size={16} />
                            My Profile
                        </button>
                        <button
                            className="w-full flex items-center gap-1 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
                            onClick={() => setThemeOpen((o) => !o)}
                        >
                            <Palette size={16} />
                            Theme
                            <ChevronDown size={13} className={`ml-auto transition-transform duration-200 ${themeOpen ? "rotate-180" : ""}`} />
                        </button>
                        {themeOpen && (
                            <div className="flex flex-col pb-0.5">
                                {([["system", Monitor, "System"], ["light", Sun, "Light"], ["dark", Moon, "Dark"]] as const).map(([value, Icon, label]) => (
                                    <button
                                        key={value}
                                        onClick={() => handleThemeChange(value)}
                                        className={`w-full flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded-md transition-colors ${
                                            theme === value
                                                ? "text-primary hover:bg-surface"
                                                : "text-text-muted hover:text-text-primary hover:bg-surface"
                                        }`}
                                    >
                                        <Icon size={14} />
                                        {label}
                                        {theme === value && <Check size={12} className="ml-auto" />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

					<div className="my-.25 border-t border-subtle" />
					<div className="p-2 flex flex-col">
						<button
							onClick={() => {
								if (otherAccounts.length > 0) {
									setSwitchUserOpen(!switchUserOpen)
								} else {
									setAccountSwitching(true);
									logoutBeacon();
									logout(true);
									queryClient.clear();
									navigate("/login");
								}
							}}
							className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
						>
							<Users size={16} />
							Switch User
							{otherAccounts.length > 0 && (
								<ChevronDown size={13} className={`ml-auto transition-transform duration-200 ${switchUserOpen ? "rotate-180" : ""}`} />
							)}
						</button>
						{switchUserOpen && otherAccounts.length > 0 && (
                            <div className="flex flex-col pb-0.5">
                                {otherAccounts.map((account) => (
									<button
										key={account.userId}
										onClick={() => {
											if (account.userId === user?.userId) return; // already logged in as this user
											setAccountSwitching(true);
											logoutBeacon();
											localStorage.removeItem("accessToken");
											useAuthStore.persist.clearStorage();
											window.location.replace(`${APP_BASE}/login?email=${encodeURIComponent(account.email)}`);
										}}
										className="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-sm rounded-md text-text-primary hover:text-text-primary hover:bg-surface transition-colors"
									>
										<UserRound size={14} className="shrink-0" />
										<div className="min-w-0 flex-1 text-left">
											<span className="block truncate">{account.name}</span>
											{account.orgName && (
												<span className="block text-xs text-text-muted truncate">{account.orgName}</span>
											)}
										</div>
										<div
											role="button"
											onClick={(e) => {
												e.stopPropagation();
												removeAccount(account.userId);
											}}
											className="ml-auto text-error hover:text-error-hover transition-colors hover:bg-error-bg rounded-sm w-5 h-5 flex items-center justify-center"
										>
											&times;
										</div>
									</button>
								))}
								<button
									onClick={() => {
										logoutBeacon();
										logout(true);
										queryClient.clear();
										navigate("/login");
									}}
									className="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-sm rounded-md text-text-primary hover:text-text-primary hover:bg-surface transition-colors"
								>
									<UserRoundPlus size={14} className="shrink-0" />
									New User
								</button>
                            </div>
                        )}
					</div>
					<div className="my-.25 border-t border-subtle" />

					<div className="p-2">
						<button
							onClick={handleLogout}
							className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error-text rounded-md hover:bg-error-bg hover:text-error transition-colors"
						>
							<LogOut size={16} />
							Logout
						</button>
					</div>
				</div>
			)}
			{accountSwitching && (
				<div className="fixed inset-0 z-[6000] flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-sm">
					<Loader2 className="w-10 h-10 animate-spin text-primary"/>
					<p className="text-sm text-text-primary">Switching account</p>
				</div>	
			)}
		</div>
	);
}
