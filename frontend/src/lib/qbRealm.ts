/**
 * Whether a record synced to QuickBooks company `accountId` belongs to the company connected now.
 * A sync flag left by a previously connected company says nothing about the current one.
 */
export function isCurrentQbRealm(
	accountId: string | null | undefined,
	qbStatus: { connected: boolean; realmId?: string } | null | undefined,
): boolean {
	return !!qbStatus?.connected && !!accountId && accountId === qbStatus.realmId;
}
