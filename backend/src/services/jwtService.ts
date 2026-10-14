import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import { getAllPermissions } from "../lib/permissionCatalogs.js";

// The subset of a dispatcher/technician row the token claims are built from.
// Deliberately excludes credential columns — they are omitted globally by the
// Prisma client (see SECRET_FIELD_OMIT in db.ts) and never belong in a token.
interface User {
	id: string;
	organization_id: string | null;
	email: string;
}
type PendingStage = "pending_otp" | "pending_totp" | "pending_mfa_enroll";

const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const OTP_SECRET = process.env.OTP_SECRET;

export const hasValidRefreshToken = async (
	userId: string,
): Promise<string | null> => {
	const record = await db.jwt_refresh_token.findFirst({
		where: {
			userId: userId,
			expiresAt: { gt: new Date() },
		},
		select: { token: true },
	});
	return record?.token ?? null;
};

export const generateAccessToken = (
	user: User,
	role: string,
	orgTimezone?: string | null,
	permissions?: string[] | null
) => {
	if (!JWT_SECRET) {
		throw new Error(
			"JWT_ACCESS_SECRET is not defined in environment variables",
		);
	}
	return jwt.sign(
		{
			uid: user.id,
			email: user.email,
			role: role,
			organization_id: user.organization_id,
			organization_timezone: orgTimezone ?? null,
			permissions: permissions ?? null,
		},
		JWT_SECRET,
		{ expiresIn: "15m" },
	);
};

export const generateRefreshToken = async (user: User, role: string) => {
	if (!JWT_REFRESH_SECRET) {
		throw new Error(
			"JWT_REFRESH_SECRET is not defined in environment variables",
		);
	}

	// checks if user already has a valid refresh token and returns it
	const oldToken = await hasValidRefreshToken(user.id);
	if (oldToken) {
		return oldToken;
	}

	const token = jwt.sign(
		{
			id: user.id,
			email: user.email,
			role: role,
			organization_id: user.organization_id,
		},
		JWT_REFRESH_SECRET,
		{ expiresIn: "7d" },
	);

	await db.jwt_refresh_token.create({
		data: {
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 day expiration
			role: role,
			token: token,
			userId: user.id,
		},
	});
	return token;
};

export const generatePendingToken = (user: User, role: string, stage: PendingStage = "pending_otp") => {
	if (!OTP_SECRET) {
		throw new Error("OTP_SECRET is not defined in environment variables");
	}

	return jwt.sign(
		{
			userId: user.id,
			role: role,
			organization_id: user.organization_id,
			stage: stage,
		},
		OTP_SECRET!,
		{ expiresIn: "10m" },
	);
};

export const verifyPendingToken = (token: string) => {
	if (!OTP_SECRET) {
		throw new Error("OTP_SECRET is not defined in environment variables");
	}

	return jwt.verify(token, OTP_SECRET) as {
		userId: string;
		role: string;
		organization_id: string | null;
		stage: PendingStage;
	};
};

// switched to more generalized function
export const generateOTPToken = (user: User, role: string) => {
	return generatePendingToken(user, role);
};

export const verifyToken = (token: string) => {
	if (!JWT_SECRET) {
		throw new Error(
			"JWT_ACCESS_SECRET is not defined in environment variables",
		);
	}

	const peek = jwt.decode(token) as { stage?: string; kind?: string } | null;
	if (peek?.stage === "pending_otp") {
		throw new Error("OTP tokens are not valid for authentication");
	}
	if (peek?.kind?.startsWith("staff")) {
		throw new Error("Staff tokens are not valid for customer routes");
	}

	return jwt.verify(token, JWT_SECRET) as {
		uid: string;
		email: string;
		role: string;
		organization_id: string | null;
		organization_timezone: string | null;
		permissions?: string[] | null;
	};
};

export const verifyRefreshToken = async (token: string) => {
	if (!JWT_REFRESH_SECRET) {
		throw new Error(
			"JWT_REFRESH_SECRET is not defined in environment variables",
		);
	}

	const storedToken = await db.jwt_refresh_token.findFirst({
		where: {
			token: token,
			expiresAt: { gt: new Date() }, // must not be expired
		},
	});

	if (!storedToken) {
		return createErrorResponse(
			ErrorCodes.INVALID_TOKEN,
			"Refresh token not found or expired",
		);
	}

	return jwt.verify(token, JWT_REFRESH_SECRET) as {
		id: string;
		email: string;
		role: string;
		organization_id: string | null;
	};
};

export const verifyOTPToken = (token: string) => {
	if (!OTP_SECRET) {
		throw new Error("OTP_SECRET is not defined in environment variables");
	}
	return jwt.verify(token, OTP_SECRET) as {
		userId: string;
		role: string;
		organization_id: string | null;
		stage: "pending_otp";
	};
};

export const refreshAccessToken = async (refreshToken: string) => {
	try {
		const user = await verifyRefreshToken(refreshToken);
		if ("error" in user) {
			return user; // pass through error response from verifyRefreshToken
		}
		if (!JWT_SECRET) {
			throw new Error(
				"JWT_ACCESS_SECRET is not defined in environment variables",
			);
		}

		// The refresh token's `role` claim only picks the table to look in; the
		// role that gets minted into the new access token is re-read from the DB
		// so a stale or tampered claim can never out-rank the current row.
		const dbUser =
			user.role === "technician"
				? await db.technician.findUnique({
						where: { id: user.id },
						select: { email: true, organization_id: true, organization_role_id: true, deactivated_at: true },
					})
				: await db.dispatcher.findUnique({
						where: { id: user.id },
						select: { email: true, organization_id: true, organization_role_id: true, role: true, deactivated_at: true },
					});

		if (!dbUser || dbUser.deactivated_at) {
			return createErrorResponse(ErrorCodes.INVALID_TOKEN, "User no longer exists");
		}

		const role = "role" in dbUser ? dbUser.role : "technician";

        let orgTimezone: string | null = null;
        if (dbUser.organization_id) {
            const org = await db.organization.findUnique({
                where: { id: dbUser.organization_id },
                select: { timezone: true },
            });
            orgTimezone = org?.timezone ?? null;
        }
		let permissions: string[];
        if (role === "admin") {
            permissions = getAllPermissions("dispatcher");
        } else if (dbUser.organization_role_id) {
            const orgRole = await db.organization_role.findUnique({
                where: { id: dbUser.organization_role_id },
                select: { permissions: true },
            });
            permissions = (orgRole?.permissions as string[]) ?? [];
        } else {
            permissions = [];
        }
        const jwtResult = jwt.sign(
                    {
                        uid: user.id,
                        email: dbUser.email,
                        role,
                        organization_id: dbUser.organization_id ?? null,
                        organization_timezone: orgTimezone,
                        permissions,
                    },
                    JWT_SECRET,
                    {expiresIn : '24h'}
                );

		return jwtResult;
	} catch (e) {
		if (e instanceof jwt.JsonWebTokenError) {
			throw new Error("Invalid refresh token");
		}
		throw new Error("Internal server error");
	}
};
