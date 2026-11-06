import { z } from "zod";

/** The dispatcher's answer when the address of a kept-address-rate document changes. */
export const addressTaxChoiceSchema = z.union([
	z.literal("keep"),
	z.literal("default"),
	z.object({ group_id: z.string().uuid() }),
]);

export type AddressTaxChoice = z.infer<typeof addressTaxChoiceSchema>;
