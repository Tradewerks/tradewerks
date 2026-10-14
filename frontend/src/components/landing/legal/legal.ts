// Shared by the legal pages and the landing footer.

// Fill these in before publishing: they appear verbatim in both documents.
export const LEGAL = {
	company: "TradeWerks",
	// Registered legal entity, e.g. "TradeWerks, LLC".
	entity: "TradeWerks",
	// State whose law governs the Terms and whose courts hear disputes.
	governingState: "Wisconsin",
	privacyEmail: "privacy@tradewerks.io",
	legalEmail: "legal@tradewerks.io",
	effectiveDate: "September 30, 2026",
};

export const LEGAL_LINKS = [
	["/terms", "Terms of Service"],
	["/privacy", "Privacy Policy"],
] as const;
