// Matches frontend/src/util/util.ts formatCurrency exactly ("$1,000.00", not toFixed's "1000.00")
export const formatCurrency = (amount: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
