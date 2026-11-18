import z from "zod";
import { json, registry } from "./shared.js";

// ===============================================================================================================================
// OAuth
// ===============================================================================================================================

const html = (description: string) => ({
	description,
	content: { "text/html": { schema: z.string() } },
});

const oauthError = z
	.object({
		error: z.enum([
			"invalid_request",
			"invalid_client",
			"invalid_grant",
			"unauthorized_client",
			"unsupported_grant_type",
		]),
		error_description: z.string().optional(),
	})
	.meta({ id: "OAuthError" });

registry.registerPath({
	method: "get",
	path: "/oauth/authorize",
	tags: ["OAuth"],
	summary: "Start authorization",
	description:
		"Opens the sign-in and consent page in the user's browser. On approval the user is redirected to `redirect_uri?code=…&state=…`; on denial to `redirect_uri?error=access_denied&state=…`.",
	request: {
		query: z.object({
			client_id: z.string().describe("Your OAuth client ID"),
			redirect_uri: z
				.string()
				.describe("Must exactly match one registered for the client"),
			response_type: z.literal("code"),
			state: z
				.string()
				.optional()
				.describe("Echoed back on the redirect"),
			code_challenge: z
				.string()
				.optional()
				.describe(
					"PKCE challenge. When sent, `/oauth/token` requires `code_verifier`.",
				),
			code_challenge_method: z
				.enum(["S256", "plain"])
				.optional()
				.describe("Anything other than `S256` is treated as plain"),
		}),
	},
	responses: {
		200: html("Sign-in and consent page"),
		302: {
			description:
				"`response_type` isn't `code`: redirects to `redirect_uri?error=unsupported_response_type&state=…`",
		},
		400: html(
			"Missing `client_id`, `redirect_uri` or `response_type`, unknown client, or `redirect_uri` not registered",
		),
	},
});

registry.registerPath({
	method: "post",
	path: "/oauth/token",
	tags: ["OAuth"],
	summary: "Get or refresh tokens",
	description:
		"Exchanges an authorization code, or rotates a refresh token. Send client credentials as HTTP Basic auth or as `client_id`/`client_secret` form fields; both are always required. Responses are plain OAuth 2.0 JSON, not the usual envelope. Refresh tokens rotate: each one works once.",
	request: {
		body: {
			content: {
				"application/x-www-form-urlencoded": {
					schema: z
						.object({
							grant_type: z.enum([
								"authorization_code",
								"refresh_token",
							]),
							client_id: z
								.string()
								.optional()
								.describe("Omit when using Basic auth"),
							client_secret: z
								.string()
								.optional()
								.describe("Omit when using Basic auth"),
							code: z
								.string()
								.optional()
								.describe(
									"`authorization_code` grant: the code from the redirect",
								),
							redirect_uri: z
								.string()
								.optional()
								.describe(
									"`authorization_code` grant: same value sent to `/oauth/authorize`",
								),
							code_verifier: z
								.string()
								.optional()
								.describe(
									"`authorization_code` grant: required if a `code_challenge` was sent",
								),
							refresh_token: z
								.string()
								.optional()
								.describe("`refresh_token` grant"),
						})
						.meta({ id: "TokenRequest" }),
				},
			},
		},
	},
	responses: {
		200: json(
			z
				.object({
					access_token: z.string(),
					token_type: z.literal("Bearer"),
					expires_in: z.number().int().describe("Seconds; 900"),
					refresh_token: z.string(),
				})
				.meta({ id: "TokenResponse" }),
			"Tokens issued",
		),
		400: json(
			oauthError,
			"Unknown `grant_type` (`unsupported_grant_type`); or bad, expired or used code, `redirect_uri` mismatch, PKCE failure, or invalid, expired or reused refresh token (`invalid_grant`)",
		),
		401: json(
			oauthError,
			"Missing, unknown or wrong client credentials (`invalid_client`)",
		),
	},
});
