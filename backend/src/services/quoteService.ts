import { Prisma } from "../../generated/prisma/client.js";
import { SOLD_BY_QUOTE_JOBS } from "./disputeAdapters.js";

/**
 * The detail-page include for a quote: client + primary contact, the request
 * with its quote-derived jobs (the sold-work evidence), the linked job, priced
 * line items, notes with their authors, and both revision-chain refs.
 *
 * Exported so the GET, the POST read-back and the PATCH read-back all return
 * the same shape — the read-backs previously dropped `previous_quote` /
 * `revised_quote` / `notes`, so a PATCH response written into the detail cache
 * stripped the lineage band and revision chips until the next refetch.
 */
export const quoteDetailInclude = {
	client: {
		select: {
			id: true,
			name: true,
			address: true,
			coords: true,
			is_active: true,
			is_tax_exempt: true,
			tax_group_id: true,
			contacts: {
				where: { is_primary: true },
				include: {
					contact: {
						select: {
							id: true,
							name: true,
							email: true,
							phone: true,
						},
					},
				},
				take: 1,
			},
		},
	},
	request: {
		select: {
			id: true,
			title: true,
			status: true,
			created_at: true,
			// The evidence soldBySiblingQuote() reads: another quote on this
			// request already sold as a job. request.status cannot stand in
			// for it — a request converted straight to a job reads
			// ConvertedToJob with nothing of this quote sold.
			jobs: SOLD_BY_QUOTE_JOBS,
		},
	},
	job: {
		select: {
			id: true,
			job_number: true,
			name: true,
			status: true,
			created_at: true,
			estimated_total: true,
		},
	},
	line_items: {
		orderBy: { sort_order: "asc" as const },
		include: {
			tax_group: { select: { name: true } },
		},
	},
	notes: {
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: {
				select: { id: true, name: true, email: true },
			},
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: {
				select: { id: true, name: true, email: true },
			},
		},
		orderBy: { created_at: "desc" as const },
	},
	// Both directions, for the same reason invoices carry their chain refs:
	// without them a revision appears from nowhere with an unexplained gap in
	// the quote-number sequence.
	previous_quote: {
		select: {
			id: true,
			quote_number: true,
			version: true,
			status: true,
		},
	},
	revised_quote: {
		select: {
			id: true,
			quote_number: true,
			version: true,
			status: true,
		},
	},
} satisfies Prisma.quoteInclude;
