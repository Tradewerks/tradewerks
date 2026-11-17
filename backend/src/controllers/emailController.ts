import { ZodError } from "zod";
import { sendEmailVerificationEmail } from "../services/emailService.js";
import { create } from "domain";
import { createErrorResponse, createSuccessResponse, ErrorCodes } from "../types/responses.js";
import { getScopedDb } from "../lib/context.js";

export const verifyEmail = async (token: string, organizationId: string) => {
    try {
        const sdb = getScopedDb(organizationId);
        const dispatcher = await sdb.dispatcher.findFirst({
            where: { email_verification_token: token },
        });

        if (!dispatcher) {
            return createErrorResponse(ErrorCodes.INVALID_TOKEN, "Invalid or expired token");
        }

        await sdb.dispatcher.update({
            where: { id: dispatcher.id },
            data: { email_verified_at: new Date(), email_verification_token: null },
        });

        return { message: "Email verified successfully" };
    }catch (e) {
        if (e instanceof ZodError) {
            return {
                err: `Validation failed: ${e.issues
                    .map((err) => err.message)
                    .join(", ")}`,
            };
        }
        throw e;
    }
};