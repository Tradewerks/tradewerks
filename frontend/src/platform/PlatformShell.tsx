import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Inbox, Layers, UserCog } from "lucide-react";
import SideNavItem from "../components/nav/SideNavItem";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import ToastViewport from "../components/ui/ToastViewport";
import StaffUserMenu from "./components/StaffUserMenu";
import { chip } from "./components/orgDetailUi";
import { useOpenRequestCount } from "./hooks";
import { usePlatformAuth } from "./store";
import { useUnsaved } from "./unsavedStore";

const ICON_SIZE = 20;

export default function PlatformShell() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const openCount = useOpenRequestCount().data?.count ?? 0;
	const [expanded, setExpanded] = useState(false);
	const [pending, setPending] = useState<null | "signout" | "back">(null);

	const signOut = () => {
		usePlatformAuth.getState().signOut();
		qc.removeQueries({ queryKey: ["platform"] });
		navigate("/platform/login", { replace: true });
	};

	const goBack = () => {
		const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
		if (idx > 0) {
			navigate(-1);
			return;
		}
		const path = location.pathname;
		if (path.includes("/tiers/")) navigate("/platform/tiers");
		else if (path !== "/platform/orgs") navigate("/platform/orgs");
	};

	// Back is a <button>, so useUnsavedGuard's document-level <a> interception never sees it.
	const requestSignOut = () => (useUnsaved.getState().dirty ? setPending("signout") : signOut());
	const requestBack = () => (useUnsaved.getState().dirty ? setPending("back") : goBack());

	return (
		<div className="flex h-screen bg-canvas text-text-primary">
			<aside
				onMouseEnter={() => setExpanded(true)}
				onMouseLeave={() => setExpanded(false)}
				className="relative w-16 flex-shrink-0 z-40"
			>
				<div
					className={`absolute inset-y-0 left-0 flex flex-col bg-base border-r border-border overflow-hidden transition-[width] duration-200 ease-in-out ${expanded ? "w-40 lg:w-44" : "w-16"}`}
				>
					<nav className="flex-1 py-2 space-y-1 overflow-y-auto overflow-x-hidden sidebar-nav">
						<SideNavItem
							expanded={expanded}
							end={false}
							to="/platform/orgs"
							icon={<Building2 size={ICON_SIZE} />}
							label="Organizations"
						/>
						<SideNavItem
							expanded={expanded}
							end={false}
							to="/platform/tiers"
							icon={<Layers size={ICON_SIZE} />}
							label="Tiers"
						/>
						<SideNavItem
							expanded={expanded}
							end={false}
							to="/platform/requests"
							icon={
								<span className="relative flex">
									<Inbox size={ICON_SIZE} />
									{openCount > 0 && (
										<span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-hover px-1 text-[10px] font-medium leading-none text-on-primary tabular-nums">
											{openCount > 99 ? "99+" : openCount}
										</span>
									)}
								</span>
							}
							label="Requests"
						/>
						<SideNavItem
							expanded={expanded}
							end={false}
							to="/platform/staff"
							icon={<UserCog size={ICON_SIZE} />}
							label="Staff"
						/>
					</nav>
				</div>
			</aside>

			<div className="flex flex-col flex-1 overflow-hidden">
				<header
					className="flex justify-between items-center px-6 h-14 bg-base border-b border-border"
					style={{
						paddingLeft: expanded ? 120 : 24,
						transition: "padding-left 200ms ease-in-out",
					}}
				>
					<div className="flex items-center gap-6">
						<div className="flex items-center gap-2">
							<span className="font-semibold text-sm whitespace-nowrap text-text-primary">
								TradeWerks
							</span>
							<span className={`hidden sm:inline ${chip}`}>
								Back office
							</span>
						</div>
						<button
							type="button"
							onClick={requestBack}
							className="flex items-center gap-2 text-text-tertiary hover:text-text-primary px-3 py-2 rounded-lg hover:bg-surface-raised group"
						>
							<ArrowLeft
								size={18}
								className="group-hover:-translate-x-1 transition-transform"
							/>
							<span className="text-sm font-medium">Back</span>
						</button>
					</div>
					<div className="flex items-center gap-3">
						<StaffUserMenu onSignOut={requestSignOut} />
					</div>
				</header>

				<main className="min-w-0 flex-1 overflow-y-auto bg-canvas p-4 md:p-6">
					<Outlet />
				</main>
			</div>

			<ConfirmDialog
				open={pending !== null}
				title="Discard unsaved changes?"
				body="The tier and module changes on the Plan card are not saved yet."
				confirmLabel={pending === "back" ? "Discard and go back" : "Discard and sign out"}
				tone="destructive"
				onConfirm={() => {
					const action = pending;
					setPending(null);
					if (action === "back") goBack();
					else signOut();
				}}
				onCancel={() => setPending(null)}
			/>
			<ToastViewport />
		</div>
	);
}
