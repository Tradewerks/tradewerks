import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../auth/authStore";
import { useDispatcherByIdQuery, useUpdateDispatcherMutation } from "../hooks/useDispatchers";
import { useTechnicianByIdQuery, useUpdateTechnicianMutation } from "../hooks/useTechnicians";
import { useThemeStore } from "../stores/themeStore";
import ProfileHeroCard from "../components/profile/ProfileHeroCard";
import ProfileDetailsForm from "../components/profile/ProfileDetailsForm";
import SecurityCard from "../components/profile/SecurityCard";
import PreferencesCard from "../components/profile/PreferencesCard";
import PermissionsCard from "../components/profile/PermissionsCard";
import MFACard from "../components/mfa/MFACard"
import UserActivityCard from "../components/profile/UserActivityCard";
import NotificationPreferenceCard from "../components/profile/NotificationPreferenceCard";

type ProfileTab = "profile" | "security" | "preferences" | "permissions" | "activity";

const STORAGE_KEY = "myProfilePage_activeTab";

const TABS: { id: ProfileTab; label: string }[] = [
	{ id: "profile", label: "Profile" },
	{ id: "security", label: "Security" },
	{ id: "preferences", label: "Preferences" },
	{ id: "permissions", label: "Permissions" },
	{ id: "activity", label: "Activity"},
];

export default function MyProfilePage() {
	const { user } = useAuthStore();
	const isTech = user?.role === "technician";
	const { data: dispatcher, isLoading: dispatcherLoading } = useDispatcherByIdQuery(
		isTech ? null : user?.userId,
	);
	const { data: technician, isLoading: technicianLoading } = useTechnicianByIdQuery(
		isTech ? user?.userId : null,
	);

	const { setTheme } = useThemeStore();

	const updateDispatcherMutation = useUpdateDispatcherMutation();
	const updateTechnicianMutation = useUpdateTechnicianMutation();

	const location = useLocation();
	const [activeTab, setActiveTab] = useState<ProfileTab>(() => {
		// A link can pick the tab via router state, e.g. { tab: "preferences" }
		const requested = (location.state as { tab?: ProfileTab } | null)?.tab;
		const stored = requested ?? (sessionStorage.getItem(STORAGE_KEY) as ProfileTab | null);
		if (stored && TABS.some((tab) => tab.id === stored)) return stored;
		return "profile";
	});
	const handleTabChange = (tab: ProfileTab) => {
		sessionStorage.setItem(STORAGE_KEY, tab);
		setActiveTab(tab);
	};

	useEffect(() => {
		if (dispatcher) {
			if (dispatcher.theme && !updateDispatcherMutation.isPending) setTheme(dispatcher.theme);
		} else if (technician) {
			if (technician.theme && !updateTechnicianMutation.isPending) setTheme(technician.theme);
		}
	}, [dispatcher, technician, setTheme, updateDispatcherMutation.isPending, updateTechnicianMutation.isPending]);

	const handleThemeChange = (newTheme: "dark" | "light" | "system") => {
		setTheme(newTheme);
		if (!user?.userId) return;
		if (isTech) {
			updateTechnicianMutation.mutate({ id: user.userId, data: { theme: newTheme } });
		} else {
			updateDispatcherMutation.mutate({ id: user.userId, data: { theme: newTheme } });
		}
	};

	const handleSave = async (data: { phone: string; title: string; description: string }) => {
		if (!user?.userId) return;
		if (isTech) {
			await updateTechnicianMutation.mutateAsync({ id: user.userId, data });
		} else {
			await updateDispatcherMutation.mutateAsync({ id: user.userId, data });
		}
	};

	const record = isTech ? technician : dispatcher;
	const isLoading = isTech ? technicianLoading : dispatcherLoading;

	if (isLoading || !record) {
		return (
			<div className="flex justify-center py-10">
				<span className="text-sm text-text-muted">Loading...</span>
			</div>
		);
	}

	const roleLabel = isTech ? "Technician" : dispatcher?.role === "admin" ? "Admin" : "Dispatcher";

	return (
		<div className="max-w-5xl mx-auto space-y-6">
			<ProfileHeroCard
				name={record.name}
				email={record.email}
				phone={record.phone ?? null}
				title={record.title ?? null}
				description={record.description ?? null}
				lastLogin={record.last_login ?? null}
				roleLabel={roleLabel}
				orgRoleName={record.organization_role?.name ?? null}
			/>

			{/* Tab bar */}
			<div role="tablist" aria-label="Profile sections" className="flex items-center border-b border-border-subtle">
				{TABS.map((tab) => (
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

			{activeTab === "profile" && (
				<div role="tabpanel" id="tabpanel-profile" aria-labelledby="tab-profile">
					<ProfileDetailsForm
						initial={{
							phone: record.phone ?? "",
							title: record.title ?? "",
							description: record.description ?? "",
						}}
						onSave={handleSave}
					/>
				</div>
			)}
			{activeTab === "security" && (
				<div role="tabpanel" id="tabpanel-security" aria-labelledby="tab-security">
					<SecurityCard />
					<br></br>
					<MFACard />
				</div>
			)}
			{activeTab === "preferences" && (
				<div role="tabpanel" id="tabpanel-preferences" aria-labelledby="tab-preferences" className="space-y-6">
					<PreferencesCard onThemeChange={handleThemeChange} />
					{!isTech && <NotificationPreferenceCard />}
				</div>
			)}
			{activeTab === "permissions" && (
				<div role="tabpanel" id="tabpanel-permissions" aria-labelledby="tab-permissions">
					<PermissionsCard
						tier={isTech ? "technician" : "dispatcher"}
					/>
				</div>
			)}
			{activeTab === "activity" && (
				<UserActivityCard />
			)}
		</div>
	);
}
