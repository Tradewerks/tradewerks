/**
 * `get_inventory_levels` — warehouse and van stock in one answer.
 *
 * Stock lives in two places in this system: the warehouse count on
 * `inventory_item.quantity`, and per-vehicle counts on `vehicle_stock_item`.
 * A dispatcher asking "do we have a blower motor" means both, so this tool
 * answers both rather than making the model stitch two calls together and
 * risk reporting only half the stock.
 */

import { z } from "zod";
import type { Prisma } from "../../../generated/prisma/client.js";
import { defineTool } from "../registry.js";

/** Columns every branch of the query below reads. */
const BASE_SELECT = {
	id: true,
	name: true,
	sku: true,
	location: true,
	quantity: true,
	unit: true,
	low_stock_threshold: true,
} as const;

interface VehicleStockLine {
	vehicle_id: string;
	vehicle: string;
	vehicle_status: string;
	qty_on_hand: number;
	qty_min: number;
	below_min: boolean;
}

export const getInventoryLevels = defineTool({
	name: "get_inventory_levels",
	title: "Get inventory levels",
	description:
		"Current stock for parts, in the warehouse and optionally broken down per vehicle. Filter by name/SKU text or " +
		"restrict to items at or below their reorder threshold. Use this for 'do we have X', 'what is running low', " +
		"or 'which van has the part'.",
	risk: "read",
	permissions: ["view_inventory"],
	input: z.object({
		query: z
			.string()
			.optional()
			.describe("Match against item name, SKU, or barcode. Omit to list everything."),
		low_stock_only: z
			.boolean()
			.default(false)
			.describe("Only items at or below their low-stock threshold. Items with no threshold set are excluded."),
		include_vehicles: z
			.boolean()
			.default(false)
			.describe("Include the per-vehicle breakdown. Off by default — it roughly triples the response size."),
		limit: z.number().int().min(1).max(100).default(25).describe("Items to return, 1-100."),
	}),
	async handler({ input, db }) {
		const text = input.query?.trim();
		const where = {
			is_active: true,
			...(text
				? {
						OR: [
							{ name: { contains: text, mode: "insensitive" as const } },
							{ sku: { contains: text, mode: "insensitive" as const } },
							{ barcode: { contains: text, mode: "insensitive" as const } },
						],
					}
				: {}),
			// A null threshold means "nobody set a reorder point", which is not the
			// same as "well stocked" — such items are excluded rather than assumed fine.
			...(input.low_stock_only ? { low_stock_threshold: { not: null } } : {}),
		};

		const total = await db.inventory_item.count({ where });

		/** Common projection. `vehicles` is undefined when the caller did not ask for it. */
		const shape = (
			item: {
				id: string;
				name: string;
				sku: string | null;
				location: string | null;
				quantity: Prisma.Decimal;
				unit: string;
				low_stock_threshold: Prisma.Decimal | null;
			},
			vehicles?: VehicleStockLine[],
		) => {
			const onHand = Number(item.quantity);
			const threshold = item.low_stock_threshold == null ? undefined : Number(item.low_stock_threshold);
			const onVehicles = vehicles?.reduce((sum, v) => sum + v.qty_on_hand, 0);
			return {
				id: item.id,
				name: item.name,
				sku: item.sku ?? undefined,
				location: item.location,
				unit: item.unit,
				warehouse_qty: onHand,
				low_stock_threshold: threshold,
				is_low: threshold !== undefined && onHand <= threshold,
				...(vehicles
					? { on_vehicles_qty: onVehicles, total_qty: onHand + (onVehicles ?? 0), vehicles }
					: {}),
			};
		};

		// Two statically-shaped queries rather than one with a conditional `select`.
		// A spread inside `select` defeats Prisma's payload inference, and mapping a
		// union of two payload shapes needs casts to narrow — branching keeps both
		// paths fully typed, at the cost of one repeated call.
		let rows: Array<ReturnType<typeof shape>>;
		let fetched: number;

		if (input.include_vehicles) {
			const items = await db.inventory_item.findMany({
				where,
				select: {
					...BASE_SELECT,
					vehicle_stocks: {
						select: {
							qty_on_hand: true,
							qty_min: true,
							vehicle: { select: { id: true, name: true, status: true } },
						},
					},
				},
				orderBy: { name: "asc" },
				take: input.limit,
			});
			fetched = items.length;
			rows = items.map((item) =>
				shape(
					item,
					item.vehicle_stocks
						.filter((v) => Number(v.qty_on_hand) > 0)
						.map((v) => ({
							vehicle_id: v.vehicle.id,
							vehicle: v.vehicle.name,
							vehicle_status: v.vehicle.status,
							qty_on_hand: Number(v.qty_on_hand),
							qty_min: Number(v.qty_min),
							below_min: Number(v.qty_on_hand) < Number(v.qty_min),
						})),
				),
			);
		} else {
			const items = await db.inventory_item.findMany({
				where,
				select: BASE_SELECT,
				orderBy: { name: "asc" },
				take: input.limit,
			});
			fetched = items.length;
			rows = items.map((item) => shape(item));
		}

		// low_stock_only can only be applied here: the comparison is between two
		// columns, which Prisma cannot express in a `where` without raw SQL.
		const shaped = rows.filter((item) => !input.low_stock_only || item.is_low);

		return {
			items: shaped,
			returned: shaped.length,
			// `total` counts rows matching the SQL filter; when low_stock_only is on,
			// the column comparison above narrows further, so say so rather than
			// letting the model read `total` as the number of low-stock items.
			matched_before_low_stock_filter: input.low_stock_only ? total : undefined,
			total: input.low_stock_only ? undefined : total,
			truncated: fetched === input.limit,
		};
	},
});
