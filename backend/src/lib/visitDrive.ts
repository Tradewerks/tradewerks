import type { getScopedDb } from "./context.js";

export const recordDrive = async (tx: Pick<ReturnType<typeof getScopedDb>, "visit_tech_drive">, techId: string, now: Date, visitId?: string | null) => {
    await tx.visit_tech_drive.updateMany({ where: { tech_id: techId, ended_at: null }, data: { ended_at: now } });
    if (visitId !== undefined) await tx.visit_tech_drive.create({ data: { visit_id: visitId, tech_id: techId, started_at: now } });
};
