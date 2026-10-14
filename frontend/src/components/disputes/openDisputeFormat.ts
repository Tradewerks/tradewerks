import type { OpenDisputeSummary } from "../../types/disputes";

/** Disputes carry no deadline; past this age the widget emphasises it. */
export const STALE_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

export const disputeAgeDays = (openedAt: string, now: number = Date.now()): number =>
	Math.max(0, Math.floor((now - new Date(openedAt).getTime()) / DAY_MS));

export const openDisputePath = (d: Pick<OpenDisputeSummary, "kind" | "document_id">): string =>
	`/dispatch/${d.kind === "quote" ? "quotes" : "invoices"}/${d.document_id}`;
