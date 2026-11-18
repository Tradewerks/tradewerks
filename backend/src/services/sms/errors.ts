import type { OrgSmsAccountIds } from "./provider.js";

/**
 * A registration step failed; `reason` is shown to the org. `partial` holds the
 * provider ids created before the failure so a retry can resume with them.
 */
export class SmsRegistrationError extends Error {
	constructor(
		public reason: string,
		public partial: Partial<OrgSmsAccountIds> = {},
	) {
		super(reason);
		this.name = "SmsRegistrationError";
	}
}
