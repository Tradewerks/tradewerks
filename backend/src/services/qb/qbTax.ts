import { qbFetch } from "../quickbooksService.js"
import { qbQueryAll } from "../qb/qbQuery.js"
import { getScopedDb } from "../../lib/context.js"
import { httpError, ErrorCodes } from "../../types/responses.js"

interface QBTaxRate {
    Id: string;
    Name: string;
    RateValue?: number;
    Active?: boolean;
}

interface QBTaxCode {
    Id: string;
    Name: string;
    Active?: boolean;
    SalesTaxRateList?: {
        TaxRateDetail?:{
            TaxRateRef?: { value: string }
            TaxTypeApplicable?: string;
        }[];
    };
}

export interface QBTaxCodeLite {
    id: string;
    name: string;
    rates: { id: string; name: string; rate: number }[];
    totalRate: number;
}

export const getQBTaxCodes = async (orgId: string): Promise<QBTaxCodeLite[]> => {
	const [taxeCodes, taxRates] = await Promise.all([
		// QB's TaxCode query rejects `Active = true` once STARTPOSITION follows it; filter here.
		qbQueryAll<QBTaxCode>(orgId, "TaxCode"),
		qbQueryAll<QBTaxRate>(orgId, "TaxRate")
	]);
    
    const rates = new Map(taxRates.map(rate => [rate.Id, rate]));

    // TAX/NON/CustomSalesTax are US pseudo-codes, valid only on lines — never as a rate code.
    const PSEUDO = new Set(["TAX", "NON", "CustomSalesTax"]);
    return taxeCodes.filter((code) => code.Active !== false && !PSEUDO.has(code.Id)).map(code =>{
        const taxRateDetails = code.SalesTaxRateList?.TaxRateDetail ?? [];
        const results = taxRateDetails
            .filter(detail => detail.TaxTypeApplicable === "TaxOnAmount" && detail.TaxRateRef?.value)
            .map(detail =>{
                const rate = rates.get(detail.TaxRateRef!.value);
                return {
                    id: detail.TaxRateRef!.value,
                    name: rate?.Name ?? "",
                    rate: Number(rate?.RateValue ?? 0)
                };
            });
        return {
            id: code.Id,
            name: code.Name,
            rates: results,
            totalRate: results.reduce((sum, rate) => sum + rate.rate, 0),
        };
    });
};

// Detect whether this QB company uses Automated Sales Tax (AST). 
// AST realms QB recomputes tax itself and ignores the manual TaxCodeRef pushed
export const getQBTaxPrefs = async (orgId: string): Promise<{ automatedSalesTax: boolean }> => {
    const res = (await qbFetch(orgId, "GET", "/query?query=" + encodeURIComponent("SELECT * FROM Preferences"))) as any;
    const prefs = res?.QueryResponse?.Preferences?.[0];
    return { automatedSalesTax: prefs?.TaxPrefs?.PartnerTaxEnabled === true };
};

//null qbTaxCodeId means remove the link
export const linkTaxCode = async (orgId: string, taxGroupId: string, qbTaxCodeId: string | null) => {
    const sdb = getScopedDb(orgId);
    const taxGroup = await sdb.tax_group.updateMany({
        where: { id: taxGroupId },
        data: { qb_tax_code_id: qbTaxCodeId }
    });
    if (taxGroup.count === 0) {
        throw httpError(404, ErrorCodes.NOT_FOUND, "Tax group not found");
    }
};

