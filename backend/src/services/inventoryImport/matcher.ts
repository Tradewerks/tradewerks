import { db } from "../../db.js";
import type { InventoryProposal, MatchDecision } from "./types.js";

interface IndexedInventoryItem {
	id: string;
	name: string;
	unit: string;
	category: string | null;
	quantity: unknown;
	updated_at: Date;
	sku: string | null;
	barcode: string | null;
	alt_ids: string[];
	is_active: boolean;
}

export interface InventoryMatchCache {
	items?: Promise<IndexedInventoryItem[]>;
}

function fold(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string | null | undefined): Set<string> {
	return new Set(fold(value).split(" ").filter(Boolean));
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let common = 0;
	for (const token of left) if (right.has(token)) common += 1;
	return common / (left.size + right.size - common);
}

export function candidateIdentity(proposal: InventoryProposal): string | null {
	if (proposal.external_id) return `external:${fold(proposal.source_namespace) || "default"}:${fold(proposal.external_id)}`;
	if (proposal.barcode) return `barcode:${fold(proposal.barcode)}`;
	if (proposal.sku) return `sku:${fold(proposal.sku)}`;
	if (proposal.alt_ids?.length) return `alt:${fold(proposal.alt_ids[0])}`;
	const name = fold(proposal.name);
	return name ? `name:${name}|${fold(proposal.unit)}|${fold(proposal.category)}` : null;
}

export async function matchInventoryCandidate(
	organizationId: string,
	proposal: InventoryProposal,
	duplicateGroup?: string,
	cache?: InventoryMatchCache,
): Promise<MatchDecision> {
	if (duplicateGroup) {
		return {
			action: "conflict",
			duplicateGroup,
			evidence: { tier: "within_import", reason: "Multiple uploaded rows share the same stable identity" },
		};
	}

	if (proposal.external_id) {
		const provider = `inventory-import:${fold(proposal.source_namespace) || "default"}`;
		const mapping = await db.item_external_mapping.findFirst({
			where: {
				provider,
				account_id: organizationId,
				external_id: proposal.external_id,
				inventory_item: { organization_id: organizationId },
			},
			include: { inventory_item: { select: { id: true, quantity: true, updated_at: true } } },
		});
		if (mapping) {
			return {
				action: "update",
				existingItemId: mapping.inventory_item.id,
				existingQuantity: Number(mapping.inventory_item.quantity),
				evidence: { tier: "external_identity", provider, external_id: proposal.external_id, existing_updated_at: mapping.inventory_item.updated_at.toISOString() },
			};
		}
	}

	if (cache) {
		cache.items ??= db.inventory_item.findMany({
			where: { organization_id: organizationId },
			select: {
				id: true,
				name: true,
				unit: true,
				category: true,
				quantity: true,
				updated_at: true,
				sku: true,
				barcode: true,
				alt_ids: true,
				is_active: true,
			},
		}) as unknown as Promise<IndexedInventoryItem[]>;
		const indexed = await cache.items;
		for (const [field, value] of [["barcode", proposal.barcode], ["sku", proposal.sku]] as const) {
			if (!value) continue;
			const matches = indexed.filter((item) => item[field] === value).slice(0, 2);
			if (matches.length === 1) {
				return {
					action: "update",
					existingItemId: matches[0].id,
					existingQuantity: Number(matches[0].quantity),
					evidence: { tier: `exact_${field}`, value, existing_updated_at: matches[0].updated_at.toISOString() },
				};
			}
			if (matches.length > 1) {
				return { action: "conflict", evidence: { tier: `ambiguous_${field}`, value, candidates: matches.map((item) => item.id) } };
			}
		}
		if (proposal.alt_ids?.length) {
			const values = new Set(proposal.alt_ids);
			const matches = indexed.filter((item) => item.alt_ids.some((id) => values.has(id))).slice(0, 3);
			if (matches.length === 1) {
				return {
					action: "update",
					existingItemId: matches[0].id,
					existingQuantity: Number(matches[0].quantity),
					evidence: { tier: "exact_alternate_id", values: proposal.alt_ids, existing_updated_at: matches[0].updated_at.toISOString() },
				};
			}
			if (matches.length > 1) {
				return { action: "conflict", evidence: { tier: "ambiguous_alternate_id", candidates: matches.map((item) => item.id) } };
			}
		}
		const scored = indexed
			.filter((item) => item.is_active)
			.map((item) => {
				let score = jaccard(tokens(proposal.name), tokens(item.name));
				if (fold(proposal.unit) && fold(proposal.unit) === fold(item.unit)) score += 0.08;
				if (fold(proposal.category) && fold(proposal.category) === fold(item.category)) score += 0.08;
				if (proposal.manufacturer && fold(item.name).includes(fold(proposal.manufacturer))) score += 0.04;
				if (proposal.model && fold(item.name).includes(fold(proposal.model))) score += 0.08;
				return { ...item, score: Math.min(score, 1) };
			})
			.filter((item) => item.score >= 0.72)
			.sort((a, b) => b.score - a.score);
		if (scored.length === 1 && scored[0].score >= 0.9) {
			return {
				action: "update",
				existingItemId: scored[0].id,
				existingQuantity: Number(scored[0].quantity),
				evidence: { tier: "high_similarity", score: scored[0].score, existing_updated_at: scored[0].updated_at.toISOString() },
			};
		}
		if (scored.length > 0) {
			return {
				action: "conflict",
				evidence: { tier: "ambiguous_similarity", candidates: scored.slice(0, 5).map((item) => ({ id: item.id, score: item.score })) },
			};
		}
		return { action: "create", evidence: { tier: "no_match" } };
	}

	for (const [field, value] of [["barcode", proposal.barcode], ["sku", proposal.sku]] as const) {
		if (!value) continue;
		const matches = await db.inventory_item.findMany({
			where: { organization_id: organizationId, [field]: value },
			select: { id: true, quantity: true, updated_at: true },
			take: 2,
		});
		if (matches.length === 1) {
			return {
				action: "update",
				existingItemId: matches[0].id,
				existingQuantity: Number(matches[0].quantity),
				evidence: { tier: `exact_${field}`, value, existing_updated_at: matches[0].updated_at.toISOString() },
			};
		}
		if (matches.length > 1) {
			return { action: "conflict", evidence: { tier: `ambiguous_${field}`, value, candidates: matches.map((m) => m.id) } };
		}
	}

	if (proposal.alt_ids?.length) {
		const matches = await db.inventory_item.findMany({
			where: { organization_id: organizationId, alt_ids: { hasSome: proposal.alt_ids } },
			select: { id: true, quantity: true, updated_at: true },
			take: 3,
		});
		if (matches.length === 1) {
			return {
				action: "update",
				existingItemId: matches[0].id,
				existingQuantity: Number(matches[0].quantity),
				evidence: { tier: "exact_alternate_id", values: proposal.alt_ids, existing_updated_at: matches[0].updated_at.toISOString() },
			};
		}
		if (matches.length > 1) {
			return { action: "conflict", evidence: { tier: "ambiguous_alternate_id", candidates: matches.map((m) => m.id) } };
		}
	}

	const existing = await db.inventory_item.findMany({
		where: { organization_id: organizationId, is_active: true },
		select: { id: true, name: true, unit: true, category: true, quantity: true, updated_at: true },
	});
	const scored = existing
		.map((item) => {
			let score = jaccard(tokens(proposal.name), tokens(item.name));
			if (fold(proposal.unit) && fold(proposal.unit) === fold(item.unit)) score += 0.08;
			if (fold(proposal.category) && fold(proposal.category) === fold(item.category)) score += 0.08;
			if (proposal.manufacturer && fold(item.name).includes(fold(proposal.manufacturer))) score += 0.04;
			if (proposal.model && fold(item.name).includes(fold(proposal.model))) score += 0.08;
			return { ...item, score: Math.min(score, 1) };
		})
		.filter((item) => item.score >= 0.72)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 1 && scored[0].score >= 0.9) {
		return {
			action: "update",
			existingItemId: scored[0].id,
			existingQuantity: Number(scored[0].quantity),
			evidence: { tier: "high_similarity", score: scored[0].score, existing_updated_at: scored[0].updated_at.toISOString() },
		};
	}
	if (scored.length > 0) {
		return {
			action: "conflict",
			evidence: { tier: "ambiguous_similarity", candidates: scored.slice(0, 5).map((item) => ({ id: item.id, score: item.score })) },
		};
	}

	return { action: "create", evidence: { tier: "no_match" } };
}
