import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { createTagSchema, updateTagSchema, setItemTagsSchema } from "../lib/validate/inventory.js";

export const getOrgTags = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return sdb.inventory_tag.findMany({
		where: { organization_id: organizationId },
		orderBy: { label: "asc" },
	});
};

export const createTag = async (data: unknown, organizationId: string) => {
	try {
		const parsed = createTagSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.inventory_tag.findFirst({
			where: { organization_id: organizationId, label: { equals: parsed.label, mode: "insensitive" } },
		});
		if (existing) return { err: "A tag with that label already exists" };

		const tag = await sdb.inventory_tag.create({
			data: { organization_id: organizationId, label: parsed.label },
		});
		return { err: "", tag };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

export const updateTag = async (tagId: string, data: unknown, organizationId: string) => {
	try {
		const parsed = updateTagSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.inventory_tag.findFirst({
			where: { id: tagId, organization_id: organizationId },
		});
		if (!existing) return { err: "Tag not found" };

		const duplicate = await sdb.inventory_tag.findFirst({
			where: {
				organization_id: organizationId,
				label: { equals: parsed.label, mode: "insensitive" },
				id: { not: tagId },
			},
		});
		if (duplicate) return { err: "A tag with that label already exists" };

		const tag = await sdb.inventory_tag.update({
			where: { id: tagId },
			data: { label: parsed.label },
		});
		return { err: "", tag };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

export const deleteTag = async (tagId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const existing = await sdb.inventory_tag.findFirst({
		where: { id: tagId, organization_id: organizationId },
	});
	if (!existing) return { err: "Tag not found" };

	await sdb.inventory_tag.delete({ where: { id: tagId } });
	return { err: "" };
};

export const setItemTags = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	_context?: UserContext,
) => {
	try {
		const parsed = setItemTagsSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const item = await sdb.inventory_item.findFirst({
			where: { id: itemId, organization_id: organizationId, is_active: true },
		});
		if (!item) return { err: "Inventory item not found" };

		const uniqueTagIds = [...new Set(parsed.tag_ids)];
		if (uniqueTagIds.length > 0) {
			const ownedCount = await sdb.inventory_tag.count({
				where: { id: { in: uniqueTagIds } },
			});
			if (ownedCount !== uniqueTagIds.length) return { err: "One or more tags not found" };
		}

		const updated = await sdb.inventory_item.update({
			where: { id: itemId },
			data: {
				tags: {
					set: parsed.tag_ids.map((id) => ({ id })),
				},
			},
			include: { tags: true },
		});
		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};
