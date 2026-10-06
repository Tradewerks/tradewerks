import { getEntitlements } from "../services/entitlementService.js";
import { z, ZodError } from "zod";
import { db } from "../db.js";
import bcrypt from "bcryptjs";
import { getAllPermissions } from "../lib/permissionCatalogs.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import {
	generateAccessToken,
	generateRefreshToken,
	verifyToken,
	verifyRefreshToken,
	generateOTPToken,
	verifyOTPToken,
	generatePendingToken,
} from "../services/jwtService.js";
import { createOTP, OTP_DISABLED } from "../services/otpServce.js";
import { Response } from "express";
import {
	sendEmail,
	sendOTPEmail,
	sendPasswordResetEmail,
} from "../services/emailService.js";
import crypto from "crypto";
import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";

interface AuthResponse {
	token: string;
	expiresIn: number;
	tokenType: string;
	refreshToken?: string;
	user?: {
		email: string;
		role: string;
	};
}

export const login = async (res: Response, email: string, password: string) => {
	try {
		const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
		if (!isValidEmail) {
			return createErrorResponse(
				ErrorCodes.INVALID_CREDENTIALS,
				"Invalid credentials",
			);
		}

		// emails are set to lower case when added to db
		// login is not case sensitive
		email = email.toLowerCase();

		// ask if last login updates automatically or if I have to add that here
		// password is omitted globally (db.ts); login is one of the few places
		// that legitimately needs the hash, so opt back in for this query only.
		let user =
			(await db.technician.findUnique({
				where: {
					email: email,
				},
				omit: { password: false },
			})) ??
			(await db.dispatcher.findUnique({
				where: {
					email: email,
				},
				omit: { password: false },
			}));
		if (!user) {
			return createErrorResponse(
				ErrorCodes.INVALID_CREDENTIALS,
				"Invalid credentials",
			);
		}
		// if dispatcher, use role from db (admin or dispatch)
		const effectiveRole = "role" in user ? user.role : "technician";

		let match = await bcrypt.compare(password, user.password);
		if (!user || !match) {
			return createErrorResponse(
				ErrorCodes.INVALID_CREDENTIALS,
				"Invalid credentials",
			);
		}

		// First login: skip OTP and go straight to forced password reset
		if (!user.last_login) {
			return await issueAuthTokens(res, user.id, effectiveRole);
		}

		// MFA takes precedence over email OTP 
		const mfa_cred = await db.mfa_credential.findFirst({
			where: {
				user_id: user.id,
				role: effectiveRole,
			},
		});

		if (mfa_cred?.enabled) {
			return {
				data: {
					challenge: "totp",
					pendingToken: generatePendingToken(user, effectiveRole, "pending_totp"),
				},
			};
		}

		// Org enforces MFA but this user hasn't enrolled → force 
		// enrollment at login before any session is issued
		if (user.organization_id) {
			const org = await db.organization.findUnique({
				where: { id: user.organization_id },
				select: { mfa_required: true },
			});
			// Enforced two-step login belongs to Security+; without it the flag is inert.
			// A failed lookup keeps enforcing: an outage must not relax a login control.
			const securityPlusOff =
				!!org?.mfa_required &&
				(await getEntitlements(user.organization_id)
					.then((e) => e.modules.security_plus !== "on")
					.catch(() => false));
			if (org?.mfa_required && !securityPlusOff) {
				return {
					data: {
						challenge: "enroll",
						pendingToken: generatePendingToken(user, effectiveRole, "pending_mfa_enroll"),
					},
				};
			}
		}

		// OTP disabled: bypass the verification step and issue tokens directly
		if (OTP_DISABLED) {
			log.info(
				{ userId: user.id, role: effectiveRole },
				"[OTP DISABLED] Bypassing OTP step on login",
			);
			return await issueAuthTokens(res, user.id, effectiveRole);
		}

		const otp = await createOTP(user.id, effectiveRole);

		const pendingToken = generateOTPToken(user, effectiveRole);
		if (!pendingToken) {
			return createErrorResponse(
				ErrorCodes.SERVER_ERROR,
				"Error generating OTP token",
			);
		}

		const sent = await sendOTPEmail(user.email, otp);
		if (!sent.success) {
			return createErrorResponse(
				ErrorCodes.SERVER_ERROR,
				"Error sending OTP email",
			);
		}
		return { data: { pendingToken } };
	} catch (e) {
		if (e instanceof ZodError) {
			log.error({ err: e }, "Login failed");
			return {
				error: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}

		return createErrorResponse(
			ErrorCodes.SERVER_ERROR,
			"Internal server error",
		);
	}
};

export const issueAuthTokens = async (
	res: Response,
	userId: string,
	role: string,
) => {
	try {
		// get user by id
		const user =
			role === "technician"
				? await db.technician.findUnique({
						where: {
							id: userId,
						},
					})
				: await db.dispatcher.findUnique({
						where: {
							id: userId,
						},
					});
		if (!user) {
			return createErrorResponse(ErrorCodes.NOT_FOUND, "User not found");
		}

		// if last login is null, force password reset and generate reset token
		const forcePasswordReset = !user.last_login;
		let resetToken: string | undefined;
		const now = new Date();

		if (forcePasswordReset) {
			resetToken = crypto.randomBytes(32).toString("hex");
			const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
			if (role === "technician") {
				await db.technician.update({
					where: { id: userId },
					data: {
						password_reset_token: resetToken,
						password_reset_token_expires_at: expiresAt,
						last_login: now,
					},
				});
			} else {
				await db.dispatcher.update({
					where: { id: userId },
					data: {
						password_reset_token: resetToken,
						password_reset_token_expires_at: expiresAt,
						last_login: now,
					},
				});
			}
		} else {
			if (role === "technician") {
				await db.technician.update({
					where: { id: userId },
					data: { last_login: now },
				});
			} else {
				await db.dispatcher.update({
					where: { id: userId },
					data: { last_login: now },
				});
			}
		}

		let orgTimezone: string | null = null;
		if (user.organization_id) {
			const org = await db.organization.findUnique({
				where: { id: user.organization_id },
				select: { timezone: true },
			});
			orgTimezone = org?.timezone ?? null;
		}

		let rolePermissions: string[];
		if (role === "admin") {
			rolePermissions = getAllPermissions("dispatcher");
		} else {
			const roleId = (user as { organization_role_id?: string | null }).organization_role_id;
			if (roleId) {
				const orgRole = await db.organization_role.findUnique({
					where: { id: roleId },
					select: { permissions: true },
				});
				rolePermissions = (orgRole?.permissions as string[]) ?? [];
			} else {
				rolePermissions = [];
			}
		}

		const accessToken = generateAccessToken(user, role, orgTimezone, rolePermissions);
		const refreshToken = await generateRefreshToken(user, role);
		// set refresh token in httpOnly cookie
		res.cookie("refreshToken", refreshToken, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
		});

		await logActivity({
			event_type: forcePasswordReset ? "auth.first_login" : "auth.login",
			action: "updated",
			entity_type: "user",
			entity_id: userId,
			organization_id: user.organization_id ?? null,
			actor_type: role,
			actor_id: userId,
			...(forcePasswordReset && {
				changes: {
					password_reset: { old: "temporary", new: "user_set" },
				},
			}),
		});
		let AuthResponse = {
			token: accessToken,
			expiresIn: 86400,
			user: {
				uid: user.id,
				email: user.email,
				role: role,
			},
			forcePasswordReset,
			resetToken,
		};
		return { data: AuthResponse };
	} catch (e) {
		if (e instanceof ZodError) {
			return createErrorResponse(
				ErrorCodes.VALIDATION_ERROR,
				`Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			);
		}
	}
};

// invalidate session token and clear cookies
// access token is cleared on front end
export const logout = async (res: Response, userData: any, token: string) => {
	try {
		const decoded = token ? checkToken(token) : null;
		const userId = decoded?.uid ?? userData?.userId;
		if (userId) {
			await db.jwt_refresh_token.deleteMany({ where: { userId } });
		}
	} catch (e) {
		log.error({ err: e }, "Logout error");
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		return createErrorResponse(
			ErrorCodes.SERVER_ERROR,
			"Internal server error",
		);
	}
	res.clearCookie("refreshToken");
};

export const checkToken = (token: string) => {
	return verifyToken(token);
};

export const checkRefreshToken = async (token: string) => {
	return await verifyRefreshToken(token);
};

export const requestPasswordReset = async (email: string, role: string) => {
	try {
		// all emails in db are set to lower case
		email = email.toLowerCase();
		const user =
			role === "technician"
				? await db.technician.findUnique({ where: { email } })
				: await db.dispatcher.findUnique({ where: { email } });

		if (!user) {
			// for security, don't reveal if email exists or not
			return { err: "" };
		}

		const token = crypto.randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

		await db.$transaction(async (tx) => {
			if (role === "technician") {
				await tx.technician.update({
					where: { email },
					data: {
						password_reset_token: token,
						password_reset_token_expires_at: expiresAt,
					},
				});
			} else {
				await tx.dispatcher.update({
					where: { email },
					data: {
						password_reset_token: token,
						password_reset_token_expires_at: expiresAt,
					},
				});
			}
		});

		const sent = await sendPasswordResetEmail(email, token, role);
		if (!sent.success) {
			// Never leave a live reset token behind when the email never went out —
			// an unsent token is only useful to someone who can read the row.
			await clearPasswordResetToken(role, email);
			return { err: "Error sending password reset email" };
		}
		await logActivity({
			event_type: "auth.password_reset_requested",
			action: "updated",
			entity_type: "user",
			entity_id: user.id,
			organization_id: user.organization_id ?? null,
			actor_type: role,
			actor_id: user.id,
		});
		return { err: "" };
	} catch (e) {
		log.error({ err: e }, "Password reset request error");
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		return { err: "Internal server error" };
	}
};

const clearPasswordResetToken = async (role: string, email: string) => {
	const data = { password_reset_token: null, password_reset_token_expires_at: null };
	try {
		if (role === "technician") {
			await db.technician.update({ where: { email }, data });
		} else {
			await db.dispatcher.update({ where: { email }, data });
		}
	} catch (e) {
		log.error({ err: e }, "Failed to clear password reset token after email failure");
	}
};

const resetPasswordSchema = z.object({
	token: z.string().min(1, "Reset token is required"),
	newPassword: z
		.string()
		.min(8, "Password must be at least 8 characters")
		.max(128, "Password must be at most 128 characters"),
	// Optional hint for which table to check first; never trusted for authorization.
	role: z.string().optional(),
});

type ResetTokenOwner = {
	role: "technician" | "dispatcher" | "admin";
	user: { id: string; organization_id: string | null; password_reset_token_expires_at: Date | null };
};

// Resolves the account that owns a reset token. The role is derived from the
// row that holds the token (dispatcher.role may be "admin"), never from the
// caller, so a reset can only ever re-issue the privileges the account already has.
const findResetTokenOwner = async (token: string, roleHint?: string): Promise<ResetTokenOwner | null> => {
	const select = { id: true, organization_id: true, password_reset_token_expires_at: true } as const;
	const lookupTechnician = async (): Promise<ResetTokenOwner | null> => {
		const tech = await db.technician.findFirst({ where: { password_reset_token: token }, select });
		return tech ? { role: "technician", user: tech } : null;
	};
	const lookupDispatcher = async (): Promise<ResetTokenOwner | null> => {
		const disp = await db.dispatcher.findFirst({
			where: { password_reset_token: token },
			select: { ...select, role: true },
		});
		return disp ? { role: disp.role, user: disp } : null;
	};
	return roleHint === "technician"
		? (await lookupTechnician()) ?? (await lookupDispatcher())
		: (await lookupDispatcher()) ?? (await lookupTechnician());
};

export const resetPassword = async (
	token: unknown,
	newPassword: unknown,
	roleHint?: unknown,
) => {
	try {
		const parsed = resetPasswordSchema.parse({ token, newPassword, role: roleHint });
		const owner = await findResetTokenOwner(parsed.token, parsed.role);

		if (
			!owner ||
			!owner.user.password_reset_token_expires_at ||
			owner.user.password_reset_token_expires_at < new Date()
		) {
			return { err: "Invalid or expired token" };
		}

		const { role, user } = owner;
		const hashedPassword = await bcrypt.hash(parsed.newPassword, 10);
		await db.$transaction(async (tx) => {
			const data = {
				password: hashedPassword,
				password_reset_token: null,
				password_reset_token_expires_at: null,
			};
			if (role === "technician") {
				await tx.technician.update({ where: { password_reset_token: parsed.token }, data });
			} else {
				await tx.dispatcher.update({ where: { password_reset_token: parsed.token }, data });
			}
		});
		await logActivity({
			event_type: "auth.password_reset",
			action: "updated",
			entity_type: "user",
			entity_id: user.id,
			organization_id: user.organization_id ?? null,
			actor_type: role,
			actor_id: user.id,
			changes: { password: { old: "[hashed]", new: "[hashed]" } },
		});
		return { err: "", userId: user.id, role };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Password reset error");
		return { err: "Internal server error" };
	}
};
