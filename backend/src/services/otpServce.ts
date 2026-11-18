import { db } from "../db.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import { verifyOTPToken } from "./jwtService.js";
import { log } from "./appLogger.js";
import crypto from "crypto";

// ============================================================================
// OTP TEMPORARILY DISABLED — needed for test runs while email delivery is
// disabled. createOTP / verifyOTP short-circuit below and the login flow in
// authenticationController bypasses the OTP step entirely. To re-enable, flip
// OTP_DISABLED to false.
// ============================================================================
export const OTP_DISABLED = true;

export const createOTP = async (userid: string, role: string) => {
	if (OTP_DISABLED) {
		log.info({ userid, role }, "[OTP DISABLED] Skipping OTP creation");
		return "000000";
	}
	const otp = crypto.randomInt(100000, 1000000).toString();
	// store otp in db with expiration time when db is set up
	await db.otp_verification.deleteMany({ where: { userId: userid } });
	await db.otp_verification.create({
		data: {
			userId: userid,
			role: role,
			otp: otp,
			expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minute expiration
		}
	});
	return otp;
};

export const verifyOTP = async (
    otp: string,
    pendingToken: string,
) => {
	if (!pendingToken) {
		return createErrorResponse(ErrorCodes.INVALID_TOKEN, "No token provided");
	}

	const payload = verifyOTPToken(pendingToken!);
	if (payload.stage !== 'pending_otp') {
		return createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Invalid session");
	}

	if (OTP_DISABLED) {
		log.info({ userId: payload.userId, role: payload.role }, "[OTP DISABLED] Auto-accepting OTP");
		return { data: { userId: payload.userId, role: payload.role } };
	}

    
	if (process.env.NODE_ENV !== "production" && otp === "000000") {
		db.otp_verification.deleteMany({ where: { userId: payload.userId } });
		return { data: { userId: payload.userId, role: payload.role } };
	}

    const otpInfo = await db.otp_verification.findFirst({
        where: {
            userId: payload.userId,
            role: payload.role
        }
    });
    // debug log removed
    if (!otpInfo) {
        return createErrorResponse(ErrorCodes.INVALID_TOKEN, "No OTP request found");
    }

    // checks if otp has expired
    if (otpInfo.expiresAt < new Date()) {
        await db.otp_verification.deleteMany({ where: { userId: payload.userId } });
        return createErrorResponse(ErrorCodes.INVALID_TOKEN, "OTP expired");
    }
    // checks number of attempts and deletes otp if 5 or more
    if (otpInfo.attempts >= 5) {
        await db.otp_verification.deleteMany({ where: { userId: payload.userId } });
        return createErrorResponse(ErrorCodes.TOO_MANY_REQUESTS, "Too many attempts. Request a new code.");
    }
    // checks if otp matches db
    if (otpInfo.otp !== otp) {
        await db.otp_verification.update({
            where: { id: otpInfo.id },
            data: { attempts: otpInfo.attempts + 1 }
        });
        return createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Invalid OTP");
    }

    // OTP is valid, delete it from the database and return user info from the token
    await db.otp_verification.deleteMany({ where: { userId: payload.userId } });
    return { data: { userId: payload.userId, role: payload.role } };
}