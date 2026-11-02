import { useAnyPermission, usePermission } from "../../hooks/usePermission";
import { useModule } from "../../hooks/useEntitlements";
import { useSearchParams } from "react-router-dom";
import { useState } from "react";
import PageHeader from "../../components/ui/PageHeader";
import FieldPurchasesSection from "../../components/fieldPurchases/FieldPurchaseSection";
import PurchaseSection from "../../components/purchases/PurchaseSection";

export type PurchaseTab = "purchasing" | "field_purchases";

const STORAGE_KEY = "purchase_activeTab";

// The page title already says "Purchases"; the tabs only need to say which kind.
const TABS: { id: PurchaseTab; label: string }[] = [
	{ id: "purchasing", label: "Orders" },
	{ id: "field_purchases", label: "Field" },
];

export default function PurchasePage() {
	// Mirrors the DispatchLayout nav gate, which admits either module on its own.
	const purchasingOn = useModule("purchasing") === "on";
	const fieldPurchasesOn = useModule("field_purchases") === "on";
	const canViewOrders = usePermission("view_purchases") && purchasingOn;
	const canViewField =
		useAnyPermission(["view_field_purchases", "review_field_purchases"]) &&
		fieldPurchasesOn;

	const tabAllowed: Record<PurchaseTab, boolean> = {
		purchasing: canViewOrders,
		field_purchases: canViewField,
	};
	const visibleTabs = TABS.filter((tab) => tabAllowed[tab.id]);
	const [searchParams, setSearchParams] = useSearchParams();
	const [activeTab, setActiveTab] = useState<PurchaseTab>(() => {
		const requested = searchParams.get("tab") as PurchaseTab | null;
		if (requested && visibleTabs.some((tab) => tab.id === requested)) return requested;
		const stored = sessionStorage.getItem(STORAGE_KEY) as PurchaseTab | null;
		if (stored && visibleTabs.some((tab) => tab.id === stored)) return stored;
		return visibleTabs[0]?.id ?? "purchasing";
	});
	const handleTabChange = (tab: PurchaseTab) => {
		sessionStorage.setItem(STORAGE_KEY, tab);
		setSearchParams({ tab }, { replace: true });
		setActiveTab(tab);
	};

	const fill = activeTab === "field_purchases";

	return (
		<div
			data-page-width={fill ? "full" : undefined}
			className={`text-text-primary ${fill ? "lg:flex lg:h-full lg:min-h-0 lg:flex-col" : ""}`}
		>
			<div className="lg:shrink-0">
				<PageHeader title="Purchases">
					<div role="tablist" aria-label="Purchase sections" className="flex items-center">
						{visibleTabs.map((tab) => (
							<button
								key={tab.id}
								id={`tab-${tab.id}`}
								role="tab"
								aria-selected={activeTab === tab.id}
								aria-controls={`tabpanel-${tab.id}`}
								onClick={() => handleTabChange(tab.id)}
								className={`px-4 py-1.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
									activeTab === tab.id
										? "border-primary text-text-primary"
										: "border-transparent text-text-tertiary hover:text-text-primary"
								}`}
							>
								{tab.label}
							</button>
						))}
					</div>
				</PageHeader>
			</div>
			{activeTab === "purchasing" && canViewOrders && (
				<div
					role="tabpanel"
					id="tabpanel-purchasing"
					aria-labelledby="tab-purchasing"
				>
					<PurchaseSection />
				</div>
			)}
			{activeTab === "field_purchases" && canViewField && (
				<div
					role="tabpanel"
					id="tabpanel-field_purchases"
					aria-labelledby="tab-field_purchases"
					className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
				>
					<FieldPurchasesSection />
				</div>
			)}
		</div>
	);
}
