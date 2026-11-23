import type { UserContext } from "./context.js";

export const isTechnicianCaller = (context: UserContext): boolean =>
    !!context.techId;

// A technician is always the actor on their own time and acceptance, whatever
// the body says; only a dispatcher names the tech they act for.
export function resolveActingTechId(
    context: UserContext,
    bodyTechId: string | undefined,
): { techId: string } | { err: string; status: 400 | 403 } {
    if (context.techId) {
        if (bodyTechId && bodyTechId !== context.techId) {
            return {
                err: "Technicians can only act as themselves.",
                status: 403,
            };
        }
        return { techId: context.techId };
    }
    if (!bodyTechId) return { err: "tech_id is required", status: 400 };
    return { techId: bodyTechId };
}
