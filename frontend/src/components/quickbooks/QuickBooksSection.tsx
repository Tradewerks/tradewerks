import { useState } from "react";
import QBItemMappingCard from "./QBItemMappingCard"
import QBConnectionCard from "./QBConnectionCard";
import QBTaxCodeMappingCard from "./QBTaxCodeMappingCard";
import QBClientSyncCard from "./QBClientSyncCard";
import QBPurchaseOrdersCard from "./QBPurchaseOrdersCard";
import { useQBStatusQuery } from "../../hooks/useQuickbooks"
import { QUICKBOOKS_ENABLED } from "../../config/features";
import QBEmployeeMappingCard from "./QBEmployeeMappingCard";

type QBTab = "clients" | "items" | "tax-codes" | "purchase-orders" | "employees";

const TABS: { id: QBTab; label: string }[] = [
    { id: "clients", label: "Clients" },
    { id: "items", label: "Items" },
    { id: "tax-codes", label: "Tax Codes" },
    { id: "purchase-orders", label: "Purchase Orders" },
    { id: "employees", label: "Employees"}
];

export default function QuickBooksSection() {
    const { data: qbStatus } = useQBStatusQuery();
    const [activeTab, setActiveTab] = useState<QBTab>("clients");

    // QuickBooks integration is temporarily disabled (see config/features).
    if (!QUICKBOOKS_ENABLED) {
        return (
            <div className="rounded-lg border border-border-subtle bg-surface px-5 py-5">
                <p className="text-sm text-text-muted leading-relaxed">
                    The QuickBooks integration is temporarily unavailable. It will be
                    re-enabled in an upcoming release.
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-border-subtle bg-base px-5 py-5">
            <QBConnectionCard />
            {qbStatus?.connected && (
                <div className="mt-4">
                    <div role="tablist" aria-label="QuickBooks sections" className="flex items-center border-b border-border-subtle mb-4">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                id={`qb-tab-${tab.id}`}
                                role="tab"
                                aria-selected={activeTab === tab.id}
                                aria-controls={`qb-tabpanel-${tab.id}`}
                                onClick={() => setActiveTab(tab.id)}
                                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
                                    activeTab === tab.id
                                        ? "border-primary text-text-primary"
                                        : "border-transparent text-text-tertiary hover:text-text-primary"
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {activeTab === "clients" && (
                        <div role="tabpanel" id="qb-tabpanel-clients" aria-labelledby="qb-tab-clients">
                            <QBClientSyncCard />
                        </div>
                    )}
                    {activeTab === "items" && (
                        <div role="tabpanel" id="qb-tabpanel-items" aria-labelledby="qb-tab-items">
                            <QBItemMappingCard />
                        </div>
                    )}
                    {activeTab === "tax-codes" && (
                        <div role="tabpanel" id="qb-tabpanel-tax-codes" aria-labelledby="qb-tab-tax-codes">
                            <QBTaxCodeMappingCard />
                        </div>
                    )}
                    {activeTab === "purchase-orders" && (
                        <div role="tabpanel" id="qb-tabpanel-purchase-orders" aria-labelledby="qb-tab-purchase-orders">
                            <QBPurchaseOrdersCard />
                        </div>
                    )}
                    {activeTab === "employees" && (
                        <div role="tabpanel" id="qb-tabpanel-employees" aria-labelledby="qb-tab-employees">
                            <QBEmployeeMappingCard />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}