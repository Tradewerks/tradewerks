import { expect, test } from "@playwright/test";

// The application decodes JWT payloads with `atob`, so keep this fixture in
// standard base64. A base64url payload can intermittently contain `_` or `-`
// (depending on the timestamp) and be treated as an expired token by browsers.
const token = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, uid: "dispatcher-1", role: "dispatcher", organization_id: "org-1", permissions: ["view_inventory", "manage_inventory"] })).toString("base64")}.x`;

test("messy workbook review, duplicate resolution, financial approval, commit, and undo", async ({ page }) => {
	test.setTimeout(60_000);
	await page.addInitScript(({ accessToken }) => {
		localStorage.setItem("accessToken", accessToken);
		localStorage.setItem("auth-storage", JSON.stringify({ state: { user: { role: "dispatcher", name: "Import Reviewer", userId: "dispatcher-1", orgId: "org-1", orgTimezone: "America/Chicago", permissions: ["view_inventory", "manage_inventory"] }, _hasHydrated: true }, version: 0 }));
	}, { accessToken: token });

	let status: "ready_for_review" | "committed" | "undone" = "ready_for_review";
	let revision = 2;
	let approved = false;
	let resolved = false;
	let quantity = 2;
	let processingReads = 1;
	let commitAttempts = 0;
	const source = { id: "source-1", original_filename: "messy-workbook.xlsx", source_type: "spreadsheet", extraction_status: "extracted", extraction_metadata: { sheetCount: 2 } };
	const inventoryItem = { id: "item-1", name: "Pleated Filter 20x20", description: "", location: "A1", quantity, unit: "each", unit_price: 12, cost: 7, sku: "FIL-2020", barcode: null, is_active: true, low_stock_threshold: 2, image_urls: [], alert_emails_enabled: false, alert_email: null, category: "Filters", is_serialized: false, is_batch_tracked: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", stock_status: "sufficient" };
	const candidate = () => ({
		id: "candidate-1", import_id: "import-1", revision: resolved ? 2 : 1,
		sheet_name: "Warehouse", row_number: 4, page_number: null, image_index: null,
		raw_values: { "Item Name": " Pleated Filter 20x20 ", SKU: "fil-2020", Qty: "10", Cost: "$7.00" },
		normalized_proposal: { name: "Pleated Filter 20x20", location: "A1", sku: "FIL-2020", quantity: 10, cost: 7, unit: "each" },
		user_overrides: {}, field_confidence: { name: 1, location: 1, sku: 1, quantity: 1, cost: 1 }, field_evidence: {},
		matching_evidence: { tier: "within_import" }, proposed_action: resolved ? "update" : "conflict",
		existing_item_id: resolved ? "item-1" : null, existing_item: resolved ? { id: "item-1", name: "Pleated Filter 20x20", sku: "FIL-2020", barcode: null, quantity: 2, unit: "each", location: "A1", cost: 7, unit_price: 12 } : null,
		duplicate_group: "sku:fil 2020", variant_group_suggestion: null, validation_issues: [], selected: true, low_confidence: false,
		financial_fields: ["quantity", "cost"], requires_financial_approval: true, financial_approved_at: approved ? "2026-09-23T12:00:00Z" : null,
		source,
	});

	const detail = () => ({
		id: "import-1", status, revision, total_count: 1, create_count: 0, update_count: resolved ? 1 : 0, skip_count: 0, conflict_count: resolved ? 0 : 1, low_confidence_count: 0,
		blocking_count: status === "ready_for_review" && (!resolved || !approved) ? 1 : 0, actionable_count: resolved ? 1 : 0, retryable: false, created_at: "2026-09-23T11:00:00Z", ready_at: "2026-09-23T11:00:02Z",
		committed_at: status === "committed" ? "2026-09-23T12:00:00Z" : null,
		undo_expires_at: status === "committed" ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
		undone_at: status === "undone" ? "2026-09-23T12:05:00Z" : null,
		financial_summary: { row_count: 1, unapproved_count: approved ? 0 : 1, quantity_total: 10, cost_total: 7, unit_price_total: 0, cost_at_receipt_total: 0 },
		sources: [source],
	});

	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const respond = (data: unknown, meta?: Record<string, unknown>, statusCode = 200) => route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify({ success: true, data, error: null, meta: { timestamp: new Date().toISOString(), ...meta } }) });
		if (path === "/inventory/imports" && request.method() === "POST") return respond({ id: "import-1", status: "uploaded", revision: 1 }, undefined, 202);
		if (path === "/inventory/imports/import-1" && request.method() === "GET") {
			if (processingReads > 0) {
				processingReads -= 1;
				return respond({
					...detail(),
					status: "processing",
					actionable_count: 0,
					sources: [{ ...source, extraction_status: "processing" }],
				});
			}
			return respond(detail());
		}
		if (path === "/inventory/imports/import-1/candidates" && request.method() === "GET") return respond([candidate()], { total: 1, page: 1, pageSize: 50, hasMore: false });
		if (path.endsWith("/candidates/candidate-1") && request.method() === "PATCH") { resolved = true; revision += 1; return respond(candidate()); }
		if (path.endsWith("/financial-approval") && request.method() === "POST") { approved = true; revision += 1; return respond({ approved_count: 1, revision, approved_at: "2026-09-23T12:00:00Z" }); }
		if (path.endsWith("/commit") && request.method() === "POST") {
			commitAttempts += 1;
			if (commitAttempts === 1) {
				return route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ success: false, data: null, error: { code: "STOCK_CHANGED_SINCE_REVIEW", message: "On-hand quantity changed after review" } }),
				});
			}
			status = "committed";
			quantity = 10;
			revision += 1;
			return respond({ id: "import-1", status, item_ids: ["item-1"], undo_expires_at: detail().undo_expires_at });
		}
		if (path.endsWith("/undo") && request.method() === "POST") { status = "undone"; quantity = 2; revision += 1; return respond({ id: "import-1", status }); }
		if (path === "/inventory" && request.method() === "GET") return respond([{ ...inventoryItem, quantity }]);
		// Keep this fixture isolated from authenticated layout queries. Any
		// unhandled API request reaching the real backend with the fixture token
		// would correctly return 401 and the global interceptor would log out.
		if (["xhr", "fetch"].includes(request.resourceType())) return respond([]);
		return route.continue();
	});

	await page.goto("/app/dispatch/inventory/imports/new");
	await page.locator("#inventory-import-files").setInputFiles({ name: "messy-workbook.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("fixture workbook") });
	await page.getByRole("button", { name: "Upload and extract" }).click();
	await expect(page).toHaveURL(/\/dispatch\/inventory\/imports\/import-1/);
	await expect(page.getByText("Reading your files")).toBeVisible();
	await expect(page.getByText("Warehouse · Row 4")).toBeVisible();
	await page.getByRole("button", { name: "Review Pleated Filter 20x20" }).click();
	await expect(page.getByText("Original file values")).toBeVisible();
	await expect(page.getByText("fil-2020", { exact: true })).toBeVisible();

	const filtered = page.waitForRequest((request) => {
		const url = new URL(request.url());
		return url.pathname.endsWith("/candidates") && url.searchParams.get("search") === "Pleated";
	});
	await page.getByPlaceholder("Search by name, SKU, or barcode").fill("Pleated");
	await filtered;

	await page.getByLabel("Update an existing item").check();
	await page.locator("select").filter({ has: page.locator('option[value="item-1"]') }).selectOption("item-1");
	await page.getByRole("button", { name: "Save item review" }).click();
	await page.getByRole("button", { name: "Approve quantities and prices" }).click();
	await expect(page.getByText("All 1 affected row approved.")).toBeVisible();
	await page.getByRole("button", { name: "Finish import" }).click();
	await expect(page.getByText("On-hand quantity changed after review")).toBeVisible();
	await page.getByRole("button", { name: "Finish import" }).click();
	await expect(page.getByRole("heading", { name: "Inventory updated" })).toBeVisible();

	await page.goto("/app/dispatch/inventory");
	await expect(page.getByText("Pleated Filter 20x20")).toBeVisible({ timeout: 15_000 });
	await page.goto("/app/dispatch/inventory/imports/import-1");
	await page.getByRole("button", { name: "Reverse this import" }).click();
	await expect(page.getByText("Import reversed. Inventory has been restored.")).toBeVisible();
});
