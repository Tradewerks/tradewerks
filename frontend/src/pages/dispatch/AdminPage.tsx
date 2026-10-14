import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import UsersSection from "../../components/admin/UsersSection";
import SettingsSection from "../../components/admin/SettingsSection";
import EntitlementsSection from "../../components/admin/EntitlementsSection";
import RolesSection from "../../components/admin/RolesSection";
import IntegrationSection from "../../components/admin/IntegrationSection";
import { usePermission } from "../../hooks/usePermission";

export type AdminTab = "users" | "settings" | "entitlements" | "roles" | "integrations";

const STORAGE_KEY = "adminPage_activeTab";

const TABS: { id: AdminTab; label: string; permission?: string }[] = [
	{ id: "users", label: "Users", permission: "view_admin" },
	{ id: "settings", label: "Settings", permission: "manage_organization" },
	{ id: "entitlements", label: "Subscription", permission: "manage_organization" },
	{ id: "roles", label: "Roles", permission: "manage_roles" },
	{ id: "integrations", label: "Integrations", permission: "manage_organization" },
];

export default function AdminPage() {
	const VIEW_ADMIN = usePermission("view_admin");
	const MANAGE_ORGANIZATION = usePermission("manage_organization");
	const MANAGE_ROLES = usePermission("manage_roles");
	const MANAGE_TAXES = usePermission("manage_taxes");
	const permMap = {
		view_admin: VIEW_ADMIN,
		manage_organization: MANAGE_ORGANIZATION || MANAGE_TAXES,
		manage_roles: MANAGE_ROLES,
	}
	const visibleTabs = TABS.filter((tab) => permMap[tab.permission as keyof typeof permMap]);
	const [searchParams, setSearchParams] = useSearchParams();
	const [activeTab, setActiveTab] = useState<AdminTab>(() => {
		const requested = searchParams.get("tab") as AdminTab | null;
		if (requested && visibleTabs.some((tab) => tab.id === requested)) return requested;
		const stored = sessionStorage.getItem(STORAGE_KEY) as AdminTab | null;
		if (stored && visibleTabs.some(tab => tab.id === stored)) return stored;
		return visibleTabs[0]?.id ?? "users";
	});
	const handleTabChange = (tab: AdminTab) => {
		sessionStorage.setItem(STORAGE_KEY, tab);
		setSearchParams({ tab }, { replace: true });
		setActiveTab(tab);
	};

	return (
		<div>
			{/* Tab bar */}
			<div role="tablist" aria-label="Admin sections" className="flex items-center border-b border-border-subtle mb-5">
				{visibleTabs.map((tab) => (
					<button
						key={tab.id}
						id={`tab-${tab.id}`}
						role="tab"
						aria-selected={activeTab === tab.id}
						aria-controls={`tabpanel-${tab.id}`}
						onClick={() => handleTabChange(tab.id)}
						className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
							activeTab === tab.id
								? "border-primary text-text-primary"
								: "border-transparent text-text-tertiary hover:text-text-primary"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			{activeTab === "users" && (
				<div role="tabpanel" id="tabpanel-users" aria-labelledby="tab-users">
					<UsersSection />
				</div>
			)}
			{activeTab === "settings" && (
				<div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
					<SettingsSection />
				</div>
			)}
			{activeTab === "entitlements" && (
				<div role="tabpanel" id="tabpanel-entitlements" aria-labelledby="tab-entitlements">
					<EntitlementsSection />
				</div>
			)}
			{activeTab === "roles" && (
				<div role="tabpanel" id="tabpanel-roles" aria-labelledby="tab-roles">
					<RolesSection />
				</div>
			)}
			{activeTab === "integrations" && (
				<div role="tabpanel" id="tabpanel-integrations" aria-labelledby="tab-integrations">
					<IntegrationSection />
				</div>
			)}
		</div>
	);
}
