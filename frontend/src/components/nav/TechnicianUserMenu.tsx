import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../auth/authStore";
import { queryClient } from "../../lib/queryClient";
import { LogOut, UserRound, Sun, Moon, Monitor, Palette, ChevronDown, Check, Receipt } from "lucide-react";
import { useOrgSettings } from "../../hooks/useOrg";
import { useThemeStore } from "../../stores/themeStore";
import { useUpdateTechnicianMutation } from "../../hooks/useTechnicians";
import { useRememberedAccountsStore } from "../../stores/rememberedAccountsStore";
import { logoutBeacon } from "../../api/authenticate";
import SwitchUserSection from "./SwitchUserSection";
import { usePermission } from "../../hooks/usePermission";

export default function TechnicianUserMenu() {
    const { user, logout } = useAuthStore();
    const [menuOpen, setMenuOpen] = useState(false);
    const canRequestPurchase = usePermission("request_field_purchase");
    const [themeOpen, setThemeOpen] = useState(false);
    const patchAccount = useRememberedAccountsStore((s) => s.patchAccount);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { data: org } = useOrgSettings();
    const { theme, setTheme } = useThemeStore();
    const updateTechnicianMutation = useUpdateTechnicianMutation();

    const handleThemeChange = (value: "system" | "light" | "dark") => {
        setTheme(value);
        if (user?.userId) {
            updateTechnicianMutation.mutate({ id: user.userId, data: { theme: value } });
        }
    };

    const [confirmingLogout, setConfirmingLogout] = useState(false);
	const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleLogout = () => {
		if (!confirmingLogout) {
			setConfirmingLogout(true);
			logoutTimerRef.current = setTimeout(() => setConfirmingLogout(false), 3000);
			return;
		}
		if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
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
				/* Matches DispatcherUserMenu — see the note there on why the underline
				   is one accent at two weights instead of a border-family grey. */
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
                            onClick={() => { navigate("/technician/profile"); setMenuOpen(false); }}
                        >
                            <UserRound size={16} />
                            My Profile
                        </button>
                        {canRequestPurchase && (
                            <button
                                className="w-full flex items-center gap-1 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
                                onClick={() => { navigate("/technician/purchases"); setMenuOpen(false); }}
                            >
                                <Receipt size={16} />
                                Field Purchases
                            </button>
                        )}
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
					<SwitchUserSection />
                    <div className="my-.25 border-t border-subtle" />
					<div className="p-2">
						<button
                            onClick={handleLogout}
                            onMouseLeave={() => {
                                if (confirmingLogout) {
                                    if (logoutTimerRef.current)
                                    clearTimeout(logoutTimerRef.current);
                                    setConfirmingLogout(false);
                                }
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm
                        rounded-md transition-colors ${
                                confirmingLogout
                                    ? "bg-error text-on-primary motion-safe:animate-pulse"
                                    : "text-error-text hover:bg-error-bg"
                            }`}
                        >
                            <LogOut size={16} />
                            {confirmingLogout ? "Confirm Logout" : "Logout"}
                        </button>
					</div>
				</div>
			)}
		</div>
	);
}