import { useTaxGroups } from "../../hooks/useTaxGroups";
import { useLinkTaxCodeMutation, useQBTaxCodesQuery, useQBTaxPrefsQuery, useUnlinkTaxCodeMutation } from "../../hooks/useQuickbooks";

export default function QBTaxCodeMappingCard() {
    const { data: taxGroups } = useTaxGroups();
    const { data: qbTaxCodes } = useQBTaxCodesQuery();
    const { data: taxPrefs } = useQBTaxPrefsQuery();
    const link = useLinkTaxCodeMutation();
    const unlink = useUnlinkTaxCodeMutation();

    // handle tax code selection
    const handleTaxCodeChange = (taxGroupId: string, qbTaxCodeId: string) => {
        if (qbTaxCodeId) {
            link.mutate({ tax_group_id: taxGroupId, qb_tax_code_id: qbTaxCodeId });
        } else {
            unlink.mutate({ tax_group_id: taxGroupId });
        }
    };

    const pending = link.isPending || unlink.isPending;

    return (
        <div>
            <p className="mb-4 text-xs text-text-muted leading-relaxed max-w-2xl">
                Link each tax group to a QuickBooks tax code so synced invoices post to the right tax bucket.
            </p>

            {taxPrefs?.automatedSalesTax && (
                <div className="mb-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text">
                    This QuickBooks company uses <strong>Automated Sales Tax</strong>. QuickBooks recalculates tax itself,
                    so these mappings are advisory — the tax code you send may be overridden.
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full min-w-[480px]">
                    <thead>
                        <tr className="border-b border-border-subtle">
                            <th className="px-5 py-2.5 text-left text-xs font-medium text-text-muted">Tax Group</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Rate</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">QuickBooks Tax Code</th>
                        </tr>
                    </thead>
                    <tbody>
                        {taxGroups?.length ? (
                            taxGroups.map((taxGroup, idx) => (
                                <tr
                                    key={taxGroup.id}
                                    className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${idx === taxGroups.length - 1 ? "border-b-0" : ""}`}
                                >
                                    <td className="px-5 py-3 text-sm font-medium text-text-primary">{taxGroup.name}</td>
                                    <td className="px-3 py-3 text-xs text-text-secondary">
                                        {(taxGroup.combined_rate * 100).toFixed(2)}%
                                    </td>
                                    <td className="px-3 py-3">
                                        <select
                                            value={taxGroup.qb_tax_code_id ?? ""}
                                            onChange={(e) => handleTaxCodeChange(taxGroup.id, e.target.value)}
                                            disabled={pending}
                                            className="w-full max-w-[260px] rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-text-primary transition-colors focus:border-primary focus:outline-none disabled:opacity-50"
                                        >
                                            <option value="">— Not linked —</option>
                                            {qbTaxCodes?.map((taxCode) => (
                                                <option key={taxCode.id} value={taxCode.id}>
                                                    {taxCode.name} — {taxCode.totalRate}%
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={3} className="px-5 py-8 text-center text-sm text-text-muted">
                                    No tax groups yet. Create one in Tax settings first.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};