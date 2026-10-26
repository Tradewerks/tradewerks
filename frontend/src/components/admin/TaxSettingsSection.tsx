import { useState } from "react";
import { useTaxSettings } from "../../hooks/useTaxSettings";
import { useTaxGroups, useTaxRates } from "../../hooks/useTaxGroups";
import DetailTabs from "../detail/DetailTabs";
import TaxModeCard from "./TaxModeCard";
import DefaultGroupRow from "./tax/DefaultGroupRow";
import TaxGroupsTab from "./tax/TaxGroupsTab";
import TaxRatesTab from "./tax/TaxRatesTab";

// Prefixed so DetailTabs' `tab-<id>` ids can't collide with AdminPage's own tabs.
type TaxTab = "tax-groups" | "tax-rates";
const TAB_KEY = "hvac.taxSettings.tab";

function readStoredTab(): TaxTab {
	try {
		const stored = localStorage.getItem(TAB_KEY);
		if (stored === "tax-groups" || stored === "tax-rates") return stored;
	} catch {
		// Storage blocked (private window); fall through.
	}
	return "tax-groups";
}

const withCount = (label: string, list: unknown[] | undefined) =>
	list ? `${label} (${list.length})` : label;

interface TaxSettingsSectionProps {
	showInactive?: boolean;
}

export default function TaxSettingsSection({ showInactive = false }: TaxSettingsSectionProps) {
	const { data: settings } = useTaxSettings();
	const { data: groups } = useTaxGroups(showInactive);
	const { data: rates } = useTaxRates(showInactive);
	const [tab, setTab] = useState<TaxTab>(readStoredTab);

	const selectTab = (next: TaxTab) => {
		setTab(next);
		try {
			localStorage.setItem(TAB_KEY, next);
		} catch {
			// Not remembered; the switch still happens.
		}
	};

	const mode = settings?.effective_tax_mode ?? "manual";
	const legacyRate = settings?.legacy_rate ?? 0;

	return (
		<TaxModeCard>
			{settings && (
				<>
					<DefaultGroupRow mode={mode} legacyRate={legacyRate} />
					<DetailTabs<TaxTab>
						label="Tax setup"
						tabs={[
							{ id: "tax-groups", label: withCount("Groups", groups) },
							{ id: "tax-rates", label: withCount("Rates", rates) },
						]}
						activeTab={tab}
						onSelect={selectTab}
					/>
					<div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
						{tab === "tax-groups" ? (
							<TaxGroupsTab
								showInactive={showInactive}
								mode={mode}
								legacyRate={legacyRate}
							/>
						) : (
							<TaxRatesTab showInactive={showInactive} />
						)}
					</div>
				</>
			)}
		</TaxModeCard>
	);
}
