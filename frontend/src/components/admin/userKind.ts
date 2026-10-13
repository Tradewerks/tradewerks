export type UserKind = "technician" | "dispatcher" | "admin";

export const USER_KIND_LABELS: Record<UserKind, string> = {
	technician: "Technician",
	dispatcher: "Dispatcher",
	admin: "Admin",
};

// "admin" is the dispatcher system role (Prisma DispatcherRole), not an organization role.
export function userKind(
	user: { userType: "technician" } | { userType: "dispatcher"; role: string }
): UserKind {
	if (user.userType === "technician") return "technician";
	return user.role === "admin" ? "admin" : "dispatcher";
}
