import { useAutoTaxMode } from "../../hooks/useAutoTaxMode";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { errorMessage } from "../../util/util";
import { useLinkTaxCodeMutation, useQBTaxCodesQuery, useQBTaxPrefsQuery, useSetPassthroughTaxCodeMutation, useUnlinkTaxCodeMutation } from "../../hooks/useQuickbooks";
import { Loader2 } from "lucide-react";

export default function QBTaxCodeMappingCard() {
    const { data: taxGroups } = useTaxGroups();
    const { data: qbTaxCodes, isLoading: qbTaxCodesLoading } = useQBTaxCodesQuery();
    const { data: taxPrefs } = useQBTaxPrefsQuery();
    const link = useLinkTaxCodeMutation();
    const unlink = useUnlinkTaxCodeMutation();
    const setPassthrough = useSetPassthroughTaxCodeMutation();
    const auto = useAutoTaxMode() === true;

    // handle tax code selection
    const handleTaxCodeChange = (taxGroupId: string, qbTaxCodeId: string) => {
        if (qbTaxCodeId) {
            link.mutate({ tax_group_id: taxGroupId, qb_tax_code_id: qbTaxCodeId });
        } else {
            unlink.mutate({ tax_group_id: taxGroupId });
        }
    };

    const pending = link.isPending || unlink.isPending || setPassthrough.isPending;

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

            {taxPrefs && !taxPrefs.automatedSalesTax && (
                <div className="mb-4 flex flex-wrap items-center gap-3">
                    <label htmlFor="qb-passthrough-code" className="text-xs font-medium text-text-secondary">
                        {auto ? "Pass-through tax code (required for automatic tax)" : "Combined tax code"}
                    </label>
                    <select
                        id="qb-passthrough-code"
                        value={taxPrefs.passthroughTaxCodeId ?? ""}
                        onChange={(e) => setPassthrough.mutate({ qb_tax_code_id: e.target.value || null })}
                        disabled={pending}
                        className="w-full max-w-[260px] rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-text-primary transition-colors focus:border-primary focus:outline-none disabled:opacity-50"
                    >
                        <option value="">— Not set —</option>
                        {taxPrefs.passthroughTaxCodeId &&
                            !qbTaxCodes?.some((c) => c.id === taxPrefs.passthroughTaxCodeId) && (
                                <option value={taxPrefs.passthroughTaxCodeId}>
                                    Code {taxPrefs.passthroughTaxCodeId}
                                    {qbTaxCodes !== undefined && " (not found in QuickBooks)"}
                                </option>
                            )}
                        {qbTaxCodes?.map((taxCode) => (
                            <option key={taxCode.id} value={taxCode.id}>
                                {taxCode.name} — {taxCode.totalRate}%
                            </option>
                        ))}
                    </select>
                    {setPassthrough.isError && (
                        <p className="basis-full text-xs text-error-text">
                            {errorMessage(setPassthrough.error, "Couldn't save the combined tax code.")}
                        </p>
                    )}
                    <p className="basis-full text-xs text-text-muted">
                        Used when an invoice's tax comes from more than one tax group, or from a group with no
                        linked code. The invoice's own tax total is sent either way.
                    </p>
                </div>
            )}

            {auto && <p className="mb-2 text-xs text-text-muted">Used only for lines with an override tax group.</p>}

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
                                        <span className="flex items-center gap-2">
                                            <select
                                                value={taxGroup.qb_tax_code_id ?? ""}
                                                onChange={(e) => handleTaxCodeChange(taxGroup.id, e.target.value)}
                                                disabled={pending}
                                                className="w-full max-w-[260px] rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-text-primary transition-colors focus:border-primary focus:outline-none disabled:opacity-50"
                                            >
                                                <option value="">{qbTaxCodesLoading ? "Loading tax codes" : "— Not linked —"}</option>
                                                {qbTaxCodes?.map((taxCode) => (
                                                    <option key={taxCode.id} value={taxCode.id}>
                                                        {taxCode.name} — {taxCode.totalRate}%
                                                    </option>
                                                ))}
                                            </select>
                                            {(qbTaxCodesLoading || pending) && (
                                                <Loader2 size={12} className="shrink-0 animate-spin text-text-muted" />
                                            )}
                                        </span>
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
