/// <reference types="node" />
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import bcryptjs from "bcryptjs";
import crypto from "crypto";
import { getAllPermissions } from "../src/lib/permissionCatalogs.js";
import { recordMovements, getOrCreateBatch, shortCode } from "../src/services/stockMovements.js";
import {
	calculateDocumentTax,
	centsToDollars,
	type TaxGroupConfig,
	type LineItemTaxInput,
} from "../src/services/taxEngine.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter });

const ORG_TIMEZONE = "America/Chicago";

/**
 * Returns a UTC Date representing h:m on the same calendar day as `base`
 * when interpreted in America/Chicago timezone. Handles DST automatically.
 */
/**
 * dateAt clamped to now. Live visits feed elapsed-time UI, so a future "actual"
 * start makes the technician work timer count up from a negative value.
 */
function actualAt(base: Date, h: number, m = 0, fallbackMinutesAgo = 20): Date {
	const at = dateAt(base, h, m);
	const now = new Date();
	return at.getTime() <= now.getTime()
		? at
		: new Date(now.getTime() - fallbackMinutesAgo * 60_000);
}

function dateAt(base: Date, h: number, m = 0): Date {
	// Get the Chicago calendar date from base (YYYY-MM-DD)
	const chicagoDateStr = base.toLocaleDateString("en-CA", { timeZone: ORG_TIMEZONE });
	// Build a naive UTC anchor at h:m on this calendar date
	const anchor = new Date(`${chicagoDateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
	// Find what Chicago local time this UTC anchor maps to
	// In a UTC environment, toLocaleString output parses back as UTC — this measures the offset
	const chicagoOfAnchor = new Date(anchor.toLocaleString("en-US", { timeZone: ORG_TIMEZONE }));
	// Apply the offset to convert naive UTC → correct UTC for this Chicago local time
	const offsetMs = anchor.getTime() - chicagoOfAnchor.getTime();
	return new Date(anchor.getTime() + offsetMs);
}

/**
 * Returns a Date anchored to the same calendar day as `offset` days from now
 * in America/Chicago timezone. Positioned at 18:00 UTC (safe afternoon in Chicago)
 * so it's unambiguous when passed to dateAt() as a base.
 */
function daysFromNow(offset: number): Date {
	const now = new Date();
	const chicagoDateStr = now.toLocaleDateString("en-CA", { timeZone: ORG_TIMEZONE }); // "YYYY-MM-DD"
	const [y, mo, d] = chicagoDateStr.split("-").map(Number);
	return new Date(Date.UTC(y, mo - 1, d + offset, 18, 0, 0));
}

function firstOfMonth(monthOffset: number): Date {
	const d = new Date();
	d.setMonth(d.getMonth() + monthOffset, 1);
	d.setHours(0, 0, 0, 0);
	return d;
}

/**
 * Pads `text` to EXACTLY `len` chars for UI stress-test fixtures. Mid-word
 * truncation is intentional — an unbreakable token is the worst case for wrapping.
 * Pass a space-free filler for code-shaped fields (sku, barcode, alt_ids).
 */
function padTo(
	text: string,
	len: number,
	filler = " Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
): string {
	if (text.length >= len) return text.slice(0, len);
	const needed = len - text.length;
	return (text + filler.repeat(Math.ceil(needed / filler.length))).slice(0, len);
}

async function main() {
	// The seed creates demo accounts with known passwords and dev-only tiers.
	if (process.env.NODE_ENV === "production") {
		console.error("Refusing to seed: NODE_ENV is production.");
		process.exit(1);
	}

	console.log("Seeding database...");

	// ============================================================================
	// OAuth2 Server — Zapier client (dev/local)
	// ============================================================================

	await db.oauth_client.create({
		data: {
			client_id: "zapier-1cb47faa2f6b213d",
			client_secret: crypto
				.createHash("sha256")
				.update("7XzU2_BJwx8fKlBl68eu5VCgnBEdRTO8D1ej0POlaoE")
				.digest("hex"),
			name: "Zapier (local test)",
			redirect_uris: [
				"http://localhost:3000/oauth/callback-test",
				"http://localhost:9000", // `zapier invoke auth start` loopback catcher
				"https://zapier.com/dashboard/auth/oauth/return/App246740CLIAPI/", // TradeWerks-Zapier (.zapierapprc id 246740)
			],
			is_confidential: true,
		},
	});

	// ============================================================================
	// Organization
	// ============================================================================

	const org = await db.organization.create({
		data: {
			name:     "TradeWerks",
			timezone: "America/Chicago",
			tax_rate: 0.0825,
			phone:    "(608) 555-0142",
			address:  "1857 Sand Lake Road, Onalaska, WI 54650",
			coords:   { lat: 44.7441, lon: -91.2396 },
			email:    "info@epicitautomations.com",
			website:  "epicitautomations.com",
			restock_mode: "tech_self_serve",
			// Over this, one dispatcher approval is not enough to release a field
			// purchase. Set below John Smith's 750 per-transaction ceiling so a single
			// purchase can be under his own limit and still need a second signer.
			field_purchase_second_signoff_threshold: 500.0,
		},
	});

	// Dev-only tier fixtures. Production gets only the Legacy tier, from the
	// migration; real tier contents are undecided.
	const OPTIONAL_MODULES = [
		"quotes", "recurring_plans", "projects", "inventory", "fleet", "vehicle_stock",
		"purchasing", "field_purchases", "followups", "disputes",
	];
	const PRO_MODULES = [...OPTIONAL_MODULES, "advanced_reporting", "quickbooks", "tax_auto", "ai_assistant"];
	await db.plan.createMany({
		data: [
			{ key: "starter", label: "Starter", assignable: true, is_signup_default: true, is_trial_default: false },
			{ key: "pro", label: "Pro", assignable: true, is_signup_default: false, is_trial_default: false },
			{ key: "enterprise", label: "Enterprise", assignable: true, is_signup_default: false, is_trial_default: true },
		],
	});
	await db.plan_version.createMany({
		data: [
			{
				id: "pv_starter_1", plan_key: "starter", version: 1, note: "seed",
				modules: OPTIONAL_MODULES,
				limits: { dispatchers: 3, technicians: 5, tax_lookups_month: 0, ai_calls_month: 0, receipt_scans_month: 0 },
			},
			{
				id: "pv_pro_1", plan_key: "pro", version: 1, note: "seed",
				modules: PRO_MODULES,
				limits: { dispatchers: 10, technicians: 25, tax_lookups_month: 2000, ai_calls_month: 500, receipt_scans_month: 300 },
			},
			{
				id: "pv_enterprise_1", plan_key: "enterprise", version: 1, note: "seed",
				modules: [...PRO_MODULES, "security_plus"],
				limits: { dispatchers: null, technicians: null, tax_lookups_month: 20000, ai_calls_month: 5000, receipt_scans_month: 3000 },
			},
		],
	});
	await db.org_entitlement.create({
		data: {
			organization_id: org.id,
			plan_version_id: "pv_legacy_1",
			plan_source: "migration",
			template_key: "hvac",
			module_choices: {
				quotes: true, recurring_plans: true, projects: true, inventory: true,
				fleet: true, vehicle_stock: true, purchasing: true, field_purchases: true,
				disputes: true, followups: true,
			},
		},
	});

	// ============================================================================
	// Tax System — rates + group (sum to 0.0825 so existing totals stay consistent)
	// ============================================================================

	const [taxStateRate, taxCountyRate] = await Promise.all([
		db.tax_rate.create({
			data: {
				organization_id: org.id,
				name: "WI State Sales Tax",
				rate: 0.0625,
				jurisdiction: "State",
				description: "Wisconsin state sales & use tax.",
				is_default: false,
				is_active: true,
			},
		}),
		db.tax_rate.create({
			data: {
				organization_id: org.id,
				name: "La Crosse County / City",
				rate: 0.02,
				jurisdiction: "County",
				description: "Combined county and city sales tax.",
				is_default: false,
				is_active: true,
			},
		}),
	]);

	const taxGroup = await db.tax_group.create({
		data: {
			organization_id: org.id,
			name: "WI Standard",
			description: "Standard Wisconsin sales tax (state + county/city).",
			is_default: true,
			is_active: true,
			rates: {
				create: [
					{ tax_rate_id: taxStateRate.id, sort_order: 0 },
					{ tax_rate_id: taxCountyRate.id, sort_order: 1 },
				],
			},
		},
	});

	// In-memory config for the centralized tax engine (mirrors taxEngine.TaxGroupConfig)
	const taxGroupConfig: TaxGroupConfig = {
		id: taxGroup.id,
		name: taxGroup.name,
		rates: [
			{ id: taxStateRate.id, name: taxStateRate.name, rate: 0.0625, jurisdiction: "State" },
			{ id: taxCountyRate.id, name: taxCountyRate.name, rate: 0.02, jurisdiction: "County" },
		],
	};

	// ============================================================================
	// Organization Roles
	// ============================================================================

	const adminRole = await db.organization_role.create({
		data: {
			organization_id: org.id,
			name: "Administrator",
			base_tier: "dispatcher",
			permissions: getAllPermissions("dispatcher"),
			is_default: false,
		},
	});

	const [dispatcherRole, technicianRole] = await Promise.all([
		db.organization_role.create({
			data: {
				organization_id: org.id,
				name: "Default Dispatcher",
				base_tier: "dispatcher",
				permissions: getAllPermissions("dispatcher").filter(
					(p) => p !== "manage_roles" && p !== "view_admin" && p !== "manage_organization" && p !== "manage_dispatchers"
				),
				is_default: true,
			},
		}),
		db.organization_role.create({
			data: {
				organization_id: org.id,
				name: "Default Technician",
				base_tier: "technician",
				permissions: getAllPermissions("technician"),
				is_default: true,
			},
		}),
	]);

	// ============================================================================
	// Users
	// ============================================================================

	const dispatcherPassword = await bcryptjs.hash("password123", 10);
	const techPassword = await bcryptjs.hash("password123", 10);

	const dispatcher = await db.dispatcher.create({
		data: {
			organization_id: org.id,
			name: "Alex Mercer",
			email: "admin@epichvac.com",
			phone: "6082550100",
			password: dispatcherPassword,
			title: "Operations Manager",
			description: "Lead dispatcher and operations manager.",
			email_verified_at: new Date(),
			email_verification_token: null,
			last_login: new Date(),
			role: "admin",
			organization_role_id: adminRole.id,
		},
	});

	const dispatcher2 = await db.dispatcher.create({
		data: {
			organization_id: org.id,
			name: "Sam Torres",
			email: "dispatcher@epichvac.com",
			phone: "6082550199",
			password: dispatcherPassword,
			title: "Dispatcher",
			description: "Test dispatcher account.",
			email_verified_at: new Date(),
			email_verification_token: null,
			last_login: new Date(),
			role: "dispatcher",
			organization_role_id: dispatcherRole.id,
		},
	});

	const [tech1, tech2, tech3] = await Promise.all([
		db.technician.create({
			data: {
				organization_id: org.id,
				name: "John Smith",
				email: "john.smith@epichvac.com",
				phone: "6082550101",
				password: techPassword,
				title: "Senior HVAC Technician",
				description:
					"10 years experience. Specializes in commercial systems.",
				status: "Available",
				hire_date: new Date("2015-03-12"),
				coords: { lat: 43.8014, lon: -91.2396 },
				hourly_rate: 95.00,
				last_login: new Date(),
				organization_role_id: technicianRole.id,
			},
		}),
		db.technician.create({
			data: {
				organization_id: org.id,
				name: "Maria Rodriguez",
				email: "maria.rodriguez@epichvac.com",
				phone: "6082550102",
				password: techPassword,
				title: "HVAC Technician",
				description:
					"5 years experience. Residential and light commercial.",
				status: "Working",
				hire_date: new Date("2020-07-01"),
				coords: { lat: 43.8129, lon: -91.2559 },
				hourly_rate: 75.00,
				organization_role_id: technicianRole.id,
			},
		}),
		db.technician.create({
			data: {
				organization_id: org.id,
				name: "Kevin Park",
				email: "kevin.park@epichvac.com",
				phone: "6082550103",
				password: techPassword,
				title: "HVAC Technician",
				description: "3 years experience. Residential specialist.",
				status: "Offline",
				hire_date: new Date("2022-04-18"),
				coords: { lat: 43.8014, lon: -91.2396 },
				hourly_rate: 65.00,
				organization_role_id: technicianRole.id,
			},
		}),
	]);

	// ============================================================================
	// Inventory — created early so visits can reference inventory_item_id
	// ============================================================================

	//
		// Lines below MIX linked and freetext on purpose: whole rooftop units and
		// fabricated curbs are freetext in the field, and the reconcile queue needs
		// a real backlog to work through.
	const [
		invRefrigerant,
		invFilter,
		invCapacitor,
		invThermostat,
		invContactor,
		invBlower,
		invIgniter,
		invFlameSensor,
		invCondPump,
		invMaxLenStress,
		invLineSet,
		invCompressor,
		invLineSetSmall,
		invTubingMetric,
	] = await Promise.all([
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Refrigerant R-410A (25 lb cylinder)",
				description:
					"Standard residential/light commercial refrigerant.",
				location: "Warehouse — Shelf A1",
				quantity: 0,
				unit_price: 60.0,
				cost: 38.0,
				sku: "REF-410A-25",
				barcode: shortCode("ITM"),
				alt_ids: ["R410A-25LB", "NU-410A"],
				low_stock_threshold: 3,
				category: "Refrigerants",
				unit: "cylinder",
				is_batch_tracked: true,
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Air Filter 16x25x1 MERV-8",
				description:
					"Standard replacement filter for residential split systems.",
				location: "Warehouse — Shelf B3",
				quantity: 0,
				unit_price: 8.5,
				cost: 3.25,
				sku: "FILT-16251-M8",
				barcode: shortCode("ITM"),
				alt_ids: ["16x25x1-M8", "AF-1625-8"],
				low_stock_threshold: 12,
				category: "Filters",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Capacitor 45+5 MFD 440V Round",
				description:
					"Dual run capacitor for condenser fan and compressor.",
				location: "Parts Room — Bin C7",
				quantity: 0,
				unit_price: 22.0,
				cost: 8.5,
				sku: "CAP-45-5-440",
				barcode: shortCode("ITM"),
				alt_ids: ["97F9895", "TRCFD455"],
				low_stock_threshold: 5,
				category: "Electrical",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Honeywell T6 Pro Programmable Thermostat",
				description:
					"7-day programmable thermostat, universal compatibility.",
				location: "Parts Room — Bin D2",
				quantity: 0,
				unit_price: 65.0,
				cost: 32.0,
				sku: "TSTAT-T6PRO",
				alt_ids: ["TH6220WF2006", "T6-PRO"],
				low_stock_threshold: 2,
				category: "Controls",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Contactor 2-Pole 40A 24V",
				description:
					"Replacement contactor for condenser units up to 5 tons.",
				location: "Parts Room — Bin C8",
				quantity: 0,
				unit_price: 28.0,
				cost: 11.0,
				sku: "CONT-2P-40A",
				alt_ids: ["42-25101-01", "C240B"],
				low_stock_threshold: 4,
				category: "Electrical",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Blower Motor 1/2 HP 115V",
				description:
					"Direct-drive PSC blower motor, 1075 RPM, 4-speed.",
				location: "Warehouse — Shelf A4",
				quantity: 0,
				unit_price: 185.0,
				cost: 96.0,
				sku: "MOT-BLW-12HP",
				barcode: shortCode("ITM"),
				alt_ids: ["FM-BL-0500", "5KCP39"],
				low_stock_threshold: 2,
				category: "Motors",
				unit: "each",
				is_serialized: true,
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Hot Surface Igniter (Universal)",
				description:
					"Universal silicon nitride hot surface igniter with mounting kit.",
				location: "Parts Room — Bin D5",
				quantity: 0,
				unit_price: 42.0,
				cost: 18.5,
				sku: "IGN-HSI-UNIV",
				alt_ids: ["IG1100", "271N"],
				low_stock_threshold: 3,
				category: "Controls",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Flame Sensor (Universal Rod)",
				description:
					"Universal flame sensor rod for gas furnace ignition systems.",
				location: "Parts Room — Bin D6",
				quantity: 0,
				unit_price: 14.0,
				cost: 4.75,
				sku: "SEN-FLAME-U",
				alt_ids: ["LH680534", "FS-UNIV"],
				low_stock_threshold: 4,
				category: "Controls",
				unit: "each",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Condensate Pump 120V",
				description:
					"Automatic condensate removal pump, 1/30 HP, 20 ft lift.",
				location: "Warehouse — Shelf B6",
				quantity: 0,
				unit_price: 78.0,
				cost: 41.0,
				sku: "PMP-COND-120",
				alt_ids: ["VCMA-20ULS", "CP-2000"],
				low_stock_threshold: 2,
				category: "Plumbing",
				unit: "each",
			},
		}),
		// UI STRESS TEST FIXTURE — every field padded to its exact validation cap
		// (lib/validate/inventory.ts) so layouts break here in dev, not at a
		// customer with verbose part names. Keep caps in sync with the schema.
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: padTo(
					"MAXLEN STRESS TEST — Universal High-Efficiency Variable-Speed Inverter-Driven Heat Pump Air Handler Replacement Assembly Kit (Commercial Rooftop, Left-Hand Return)",
					255,
				),
				description: padTo(
					"MAXLEN STRESS TEST — this description occupies the full 5000-character cap. The next token has no break opportunity anywhere in it, which is the worst case for any container that relies on word wrapping: " +
						"UNBREAKABLE".repeat(16) +
						" Everything after this point is filler prose so that clamped descriptions, expand/collapse toggles, tooltips, table cells and print layouts all get exercised at the true limit. ",
					5000,
				),
				location: padTo(
					"Warehouse — Building 3, Mezzanine Level 2, Aisle 14, Rack Section D, Shelf 7, Bin 22-B (Overflow Tote, Behind The Seasonal Equipment Pallets)",
					255,
				),
				quantity: 0,
				// Decimal(10, 2) ceiling — 8 integer digits + 2 decimals. Cost is
				// deliberately identical to price: both fields at max width is what
				// the currency columns have to survive.
				unit_price: 99999999.99,
				cost: 99999999.99,
				sku: padTo("STRESS-MAXLEN-SKU-", 100, "X"),
				barcode: padTo("STRESSMAXLENBARCODE", 200, "0"),
				alt_ids: Array.from({ length: 12 }, (_, i) =>
					padTo(`STRESS-ALT-ID-${String(i + 1).padStart(2, "0")}-`, 100, "X"),
				),
				// Decimal(10, 2) ceiling; qty 0 keeps it permanently below threshold so
				// low-stock badges and reorder tables render the full 8-digit number.
				low_stock_threshold: 99999999.99,
				category: padTo("Stress Test Category — Very Long Freetext Grouping Axis Label", 100),
				unit: "cylinder",
				// 254-char RFC-maximum address (64-char local + 189-char domain).
				alert_emails_enabled: true,
				alert_email: `${padTo("inventory-maxlength-stress-test-alerts-mailbox", 64, "x")}@${padTo("stress-subdomain-one", 63, "x")}.${padTo("stress-subdomain-two", 63, "x")}.${padTo("verylongtldsegment", 61, "x")}`,
				// Dual-tracked so serial AND batch badges stack on the same row.
				is_serialized: true,
				is_batch_tracked: true,
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Copper Line Set 3/8 x 3/4",
				description:
					"Insulated copper refrigerant line set, sold by the foot.",
				location: "Warehouse — Rack C1",
				quantity: 0,
				unit_price: 6.5,
				cost: 3.1,
				sku: "LINE-38-34",
				alt_ids: ["LS-3834", "CU-LINESET"],
				low_stock_threshold: 20,
				category: "Refrigerants",
				unit: "ft",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "DEMO - Compressor 3-Ton Scroll R410A",
				description:
					"Copeland scroll compressor for 3-ton split systems. Serialized for warranty tracking and lot-tracked for defect recalls.",
				location: "Warehouse — Shelf A2",
				quantity: 0,
				unit_price: 620.0,
				cost: 410.0,
				sku: "COMP-3T-SCRL",
				barcode: shortCode("ITM"),
				alt_ids: ["ZP31K5E-PFV", "CMP-3T-SCRL"],
				low_stock_threshold: 1,
				category: "Compressors",
				unit: "each",
				is_serialized: true,
				is_batch_tracked: true,
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				// FRACTIONAL FIXTURE — reaches 12.5 ft through the opening receive
				// below, not by being written here. Same rule as every other item:
				// quantity is a cache of the ledger.
				name: "Copper Line Set 1/4 x 3/8 (Small)",
				description:
					"Insulated copper refrigerant line set, smaller gauge for compact systems, sold by the foot.",
				location: "Warehouse — Rack C1",
				quantity: 0,
				unit_price: 7.5,
				cost: 3.8,
				sku: "LINE-14-38",
				barcode: shortCode("ITM"),
				alt_ids: ["LS-1438", "CU-LINESET-SMALL"],
				low_stock_threshold: 15,
				category: "Refrigerants",
				unit: "ft",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				// METRIC FIXTURE — the only `m` item in the seed. 9.52mm is the
				// tube's OD spec (3/8"), not the stocking unit — sold by the meter
				// off the coil. On-hand arrives through the opening receive below,
				// same as everything else.
				name: "Copper Refrigerant Tubing 9.52mm OD",
				description:
					"Seamless copper tubing in metric dimensions, standard for European HVAC systems and metric-spec installations. Sold by the meter off the coil.",
				location: "Warehouse — Rack C2",
				quantity: 0,
				unit_price: 22.0,
				cost: 11.5,
				sku: "TUBE-9.52MM",
				barcode: shortCode("ITM"),
				alt_ids: ["TUBE-952-EU", "CU-TUBE-METRIC"],
				low_stock_threshold: 15,
				category: "Refrigerants",
				unit: "m",
			},
		}),
	]);

	// ============================================================================
	// Contacts
	// ============================================================================

	const [contact1, contact2, contact3, contact4, contact5, contact6] =
		await Promise.all([
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Robert Johnson",
					email: "robert.johnson@email.com",
					phone: "6082551001",
					type: "customer",
				},
			}),
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Jennifer Lee",
					email: "j.lee@smithcommercial.com",
					phone: "6082551002",
					type: "customer",
				},
			}),
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Sarah Williams",
					email: "sarah@williamsproperty.com",
					phone: "6082551003",
					type: "customer",
				},
			}),
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Michael Anderson",
					email: "m.anderson@andersonoffice.com",
					phone: "6082551004",
					type: "customer",
				},
			}),
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Tom Davis",
					email: "t.davis@andersonoffice.com",
					phone: "6082551005",
					type: "customer",
				},
			}),
			db.contact.create({
				data: {
					organization_id: org.id,
					name: "Linda Nguyen",
					email: "l.nguyen@riversideapts.com",
					phone: "6082551006",
					type: "customer",
				},
			}),
		]);

	// ============================================================================
	// Clients
	// ============================================================================

	const [client1, client2, client3, client4, client5] = await Promise.all([
		db.client.create({
			data: {
				organization_id: org.id,
				name: "Johnson Residence",
				address: "2842 Main St, La Crosse, WI 54601",
				coords: { lat: 43.8124, lon: -91.2568 },
				is_tax_exempt: false,
				tax_group_id: taxGroup.id,
			},
		}),
		db.client.create({
			data: {
				organization_id: org.id,
				name: "Smith Commercial Properties",
				address: "401 Main St, La Crosse, WI 54601",
				coords: { lat: 43.8129, lon: -91.2559 },
				is_tax_exempt: false,
				tax_group_id: taxGroup.id,
			},
		}),
		db.client.create({
			data: {
				organization_id: org.id,
				name: "Williams Property Management",
				address: "3003 Losey Blvd S, La Crosse, WI 54601",
				coords: { lat: 43.7889, lon: -91.2297 },
				is_tax_exempt: false,
			},
		}),
		db.client.create({
			data: {
				organization_id: org.id,
				name: "Anderson Office Complex",
				address: "3800 Commerce St, La Crosse, WI 54603",
				coords: { lat: 43.8334, lon: -91.2601 },
				is_tax_exempt: true,
			},
		}),
		db.client.create({
			data: {
				organization_id: org.id,
				name: "Riverside Apartments LLC",
				address: "1420 Rose St, La Crosse, WI 54603",
				coords: { lat: 43.8198, lon: -91.2514 },
				is_tax_exempt: false,
			},
		}),
	]);

	// Link contacts → clients
	await Promise.all([
		db.client_contact.create({
			data: {
				client_id: client1.id,
				contact_id: contact1.id,
				relationship: "owner",
				is_primary: true,
				is_billing: true,
			},
		}),
		db.client_contact.create({
			data: {
				client_id: client2.id,
				contact_id: contact2.id,
				relationship: "manager",
				is_primary: true,
				is_billing: true,
			},
		}),
		db.client_contact.create({
			data: {
				client_id: client3.id,
				contact_id: contact3.id,
				relationship: "owner",
				is_primary: true,
				is_billing: true,
			},
		}),
		db.client_contact.create({
			data: {
				client_id: client4.id,
				contact_id: contact4.id,
				relationship: "manager",
				is_primary: true,
				is_billing: false,
			},
		}),
		db.client_contact.create({
			data: {
				client_id: client4.id,
				contact_id: contact5.id,
				relationship: "contact",
				is_primary: false,
				is_billing: true,
			},
		}),
		db.client_contact.create({
			data: {
				client_id: client5.id,
				contact_id: contact6.id,
				relationship: "manager",
				is_primary: true,
				is_billing: true,
			},
		}),
	]);

	await Promise.all([
		db.client_note.create({
			data: {
				organization_id: org.id,
				client_id: client1.id,
				content:
					"Customer prefers morning appointments. Dog in backyard — call ahead before accessing side gate.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.client_note.create({
			data: {
				organization_id: org.id,
				client_id: client4.id,
				content:
					"Tax exempt — verify certificate on file annually. Contact Tom Davis for access to mechanical room on sub-level.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.client_note.create({
			data: {
				organization_id: org.id,
				client_id: client5.id,
				content:
					"24-unit complex. HVAC access requires 48hr notice to tenants. Linda prefers email communication for scheduling.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// ============================================================================
	// Service Requests
	// ============================================================================

	const [req1, req2, req3, req4, req5] = await Promise.all([
		// ConvertedToJob — AC repair (Johnson)
		db.request.create({
			data: {
				organization_id: org.id,
				client_id: client1.id,
				title: "AC Not Cooling",
				description:
					"Main AC unit is running but not producing cold air. House is 82°F.",
				priority: "High",
				address: client1.address,
				coords: { lat: 43.8124, lon: -91.2568 },
				status: "ConvertedToJob",
				source: "phone",
				created_by_dispatcher_id: dispatcher.id,
			},
		}),
		// Quoted — commercial furnace (Smith)
		db.request.create({
			data: {
				organization_id: org.id,
				client_id: client2.id,
				title: "Furnace Not Starting",
				description:
					"Rooftop unit on building 2 will not ignite. Tenants reporting cold offices.",
				priority: "Urgent",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				status: "Quoted",
				source: "email",
				requires_quote: true,
				created_by_dispatcher_id: dispatcher.id,
			},
		}),
		// New — annual PM (Williams)
		db.request.create({
			data: {
				organization_id: org.id,
				client_id: client3.id,
				title: "Annual Preventive Maintenance — 4 Units",
				description:
					"Requesting annual maintenance for 4 residential units across managed properties.",
				priority: "Low",
				address: client3.address,
				coords: { lat: 43.7889, lon: -91.2297 },
				status: "New",
				source: "web",
				created_by_dispatcher_id: dispatcher.id,
			},
		}),
		// Reviewing — thermostat replacement (Riverside Apartments)
		db.request.create({
			data: {
				organization_id: org.id,
				client_id: client5.id,
				title: "Thermostat Replacement — Units 4, 8, 12",
				description:
					"Three units have failing programmable thermostats not holding set points overnight.",
				priority: "Medium",
				address: client5.address,
				coords: { lat: 43.8198, lon: -91.2514 },
				status: "Reviewing",
				source: "phone",
				requires_quote: true,
				estimated_value: 350.0,
				created_by_dispatcher_id: dispatcher.id,
			},
		}),
		// Cancelled — duct cleaning (Johnson)
		db.request.create({
			data: {
				organization_id: org.id,
				client_id: client1.id,
				title: "Duct Cleaning — Full House",
				description: "Customer requested full duct cleaning estimate.",
				priority: "Low",
				address: client1.address,
				coords: { lat: 43.8124, lon: -91.2568 },
				status: "Cancelled",
				source: "phone",
				cancelled_at: daysFromNow(-10),
				cancellation_reason:
					"Customer decided to postpone until next spring.",
				created_by_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// QuoteRejected — the request behind Q-0008. Written directly because the
	// server refuses Reviewing → QuoteRejected and the one Quoted request is
	// already spoken for.
	const reqQuoteRejected = await db.request.create({
		data: {
			organization_id: org.id,
			client_id: client3.id,
			title: "Attic Insulation Top-Up",
			description: "Client asked for a price to bring the main attic up to R-49.",
			priority: "Low",
			address: client3.address,
			coords: { lat: 43.7889, lon: -91.2297 },
			status: "QuoteRejected",
			source: "phone",
			requires_quote: true,
			created_by_dispatcher_id: dispatcher.id,
		},
	});

	await Promise.all([
		db.request_note.create({
			data: {
				organization_id: org.id,
				request_id: req2.id,
				content:
					"Jennifer confirmed the unit has been making a clicking sound for 2 days before failing. Likely igniter or gas valve issue.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.request_note.create({
			data: {
				organization_id: org.id,
				request_id: req4.id,
				content:
					"Spoke with Linda — units 4 and 8 are most urgent. Unit 12 is secondary. Building access any weekday after 9am.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// ============================================================================
	// Quotes
	// ============================================================================

	// Q-0001: Approved — rooftop unit replacement (Smith)
	const quote1 = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0001",
			client_id: client2.id,
			request_id: req2.id,
			title: "Rooftop Unit Replacement — Bldg 2",
			description:
				"Replace failed 5-ton rooftop unit with Carrier 48TCED06A2A5.",
			status: "Approved",
			address: client2.address,
			coords: { lat: 43.8129, lon: -91.2559 },
			priority: "Urgent",
			subtotal: 6800.0,
			tax_rate: 0.0825,
			tax_amount: 561.0,
			total: 7361.0,
			sent_at: daysFromNow(-5),
			viewed_at: daysFromNow(-4),
			approved_at: daysFromNow(-3),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Carrier 5-Ton Rooftop Unit 48TCED06A2A5",
						quantity: 1,
						unit_price: 4800.0,
						total: 4800.0,
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Installation Labor",
						quantity: 8,
						unit_price: 175.0,
						total: 1400.0,
						item_type: "labor",
						sort_order: 1,
					},
					{
						name: "Refrigerant R-410A (10 lbs)",
						quantity: 10,
						unit_price: 60.0,
						total: 600.0,
						item_type: "material",
						inventory_item_id: invRefrigerant.id,
						sort_order: 2,
					},
				],
			},
		},
	});

	// Q-0002: Draft — thermostat replacement (Riverside), with percent discount
	const quote2 = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0002",
			client_id: client5.id,
			request_id: req4.id,
			title: "Thermostat Replacement — Riverside Apts Units 4, 8, 12",
			description:
				"Replace 3 failing programmable thermostats with Honeywell T6 Pro units. Includes installation and system test.",
			status: "Draft",
			address: client5.address,
			coords: { lat: 43.8198, lon: -91.2514 },
			priority: "Medium",
			subtotal: 300.0,
			tax_rate: 0.0825,
			discount_type: "percent",
			discount_value: 10.0,
			discount_amount: 30.0,
			tax_amount: 22.28,
			total: 292.28,
			valid_until: daysFromNow(14),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Honeywell T6 Pro Programmable Thermostat",
						quantity: 3,
						unit_price: 65.0,
						total: 195.0,
						item_type: "equipment",
						inventory_item_id: invThermostat.id,
						sort_order: 0,
					},
					{
						name: "Installation Labor (1 hr × 3 units)",
						quantity: 3,
						unit_price: 35.0,
						total: 105.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	await Promise.all([
		db.quote_note.create({
			data: {
				organization_id: org.id,
				quote_id: quote1.id,
				content:
					"Approved via phone by Jennifer Lee. Purchase order pending from accounting.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.quote_note.create({
			data: {
				organization_id: org.id,
				quote_id: quote2.id,
				content:
					"10% new-client discount applied. Confirm thermostat compatibility with 2-wire baseboard heat in units 4 and 12 before sending.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// ============================================================================
	// Recurring Plans
	// ============================================================================

	const occurrencePastStart = dateAt(firstOfMonth(-1), 8);
	const occurrencePastEnd = dateAt(firstOfMonth(-1), 12);
	const occurrenceSkippedStart = dateAt(firstOfMonth(-3), 8);
	const occurrenceSkippedEnd = dateAt(firstOfMonth(-3), 12);
	const occurrenceFutureStart = dateAt(firstOfMonth(1), 8);
	const occurrenceFutureEnd = dateAt(firstOfMonth(1), 12);
	const weeklyOccStart1 = dateAt(daysFromNow(-7), 7);
	const weeklyOccEnd1 = dateAt(daysFromNow(-7), 9);
	const weeklyOccStart2 = dateAt(daysFromNow(7), 7);
	const weeklyOccEnd2 = dateAt(daysFromNow(7), 9);

	// Plan 1: Monthly — Williams Properties (per_visit billing, on_completion invoicing)
	const recurringPlan1 = await db.recurring_plan.create({
		data: {
			organization_id: org.id,
			client_id: client3.id,
			name: "Monthly HVAC Maintenance — Williams Properties",
			description:
				"Monthly preventive maintenance across all Williams Property Management units. Includes filter replacement, coil inspection, and full system check.",
			address: client3.address,
			coords: { lat: 43.7889, lon: -91.2297 },
			priority: "Medium",
			status: "Active",
			starts_at: daysFromNow(-180),
			timezone: "America/Chicago",
			billing_mode: "per_visit",
			invoice_timing: "on_completion",
			created_by_dispatcher_id: dispatcher.id,
			rules: {
				create: [
					{
						frequency: "monthly",
						interval: 1,
						by_month_day: 1,
						arrival_constraint: "between",
						finish_constraint: "when_done",
						arrival_window_start: "08:00",
						arrival_window_end: "09:00",
					},
				],
			},
			line_items: {
				create: [
					{
						name: "PM Labor (4 hrs)",
						quantity: 4,
						unit_price: 125.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Air Filter 16x25x1 MERV-8 (4-pack)",
						quantity: 4,
						unit_price: 8.5,
						item_type: "material",
						inventory_item_id: invFilter.id,
						sort_order: 1,
					},
				],
			},
		},
	});

	// Plan 2: Weekly — Anderson Office Complex (subscription, schedule-date invoicing, uses recurring_rule_weekday)
	const recurringPlan2 = await db.recurring_plan.create({
		data: {
			organization_id: org.id,
			client_id: client4.id,
			name: "Weekly Filter Checks — Anderson Office Complex",
			description:
				"Weekly MERV-13 filter inspection and replacement for 3 rooftop units. Required by building air quality policy.",
			address: client4.address,
			coords: { lat: 43.8334, lon: -91.2601 },
			priority: "Low",
			status: "Active",
			starts_at: daysFromNow(-90),
			timezone: "America/Chicago",
			billing_mode: "subscription",
			invoice_timing: "on_schedule_date",
			created_by_dispatcher_id: dispatcher.id,
			rules: {
				create: [
					{
						frequency: "weekly",
						interval: 1,
						arrival_constraint: "at",
						finish_constraint: "when_done",
						arrival_time: "07:00",
						by_weekday: {
							create: [{ weekday: "MO" }],
						},
					},
				],
			},
			line_items: {
				create: [
					{
						name: "Filter Inspection Labor (1 hr)",
						quantity: 1,
						unit_price: 95.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "MERV-13 Filter 20x25x2 (3-pack)",
						quantity: 1,
						unit_price: 45.0,
						item_type: "material",
						sort_order: 1,
					},
				],
			},
		},
	});

	// Invoice schedules for both plans
	await Promise.all([
		db.invoice_schedule.create({
			data: {
				recurring_plan_id: recurringPlan1.id,
				frequency: "on_visit_completion",
				billing_basis: "visit_actuals",
				payment_terms_days: 30,
				auto_send: false,
				memo_template:
					"Monthly HVAC maintenance services — Williams Properties",
				is_active: true,
				next_invoice_at: occurrenceFutureStart,
				last_invoiced_at: occurrencePastStart,
			},
		}),
		db.invoice_schedule.create({
			data: {
				recurring_plan_id: recurringPlan2.id,
				frequency: "monthly",
				billing_basis: "plan_line_items",
				day_of_month: 1,
				payment_terms_days: 15,
				auto_send: true,
				memo_template:
					"Weekly HVAC filter service — Anderson Office Complex",
				is_active: true,
				next_invoice_at: firstOfMonth(1),
				last_invoiced_at: firstOfMonth(-1),
			},
		}),
	]);

	await Promise.all([
		db.recurring_plan_note.create({
			data: {
				organization_id: org.id,
				recurring_plan_id: recurringPlan1.id,
				content:
					"Sarah requested visits always on the 1st of the month before 9am so tenants are not disturbed during business hours.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.recurring_plan_note.create({
			data: {
				organization_id: org.id,
				recurring_plan_id: recurringPlan2.id,
				content:
					"Anderson building requires sign-in at front desk. Security badge must be requested from Tom Davis at least 24hrs in advance.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// ============================================================================
	// Projects — created before Jobs so job rows can set project_id directly.
	// Covers every project_status and priority value, plus an unassigned manager
	// so the projects report's "By Manager" breakdown has an Unassigned bucket.
	// Budgets are sized against the attached job totals below: P-0001/P-0002 land
	// around 75-80% spent, P-0004 finishes slightly over, P-0005 sits at ~98%.
	// ============================================================================

	const [
		project1,
		project2,
		project3,
		project4,
		project5,
		project6,
	] = await Promise.all([
		// P-0001: Active — multi-building rooftop replacement (Smith)
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0001",
				name: "Rooftop Unit Replacement Program — Smith Commercial",
				description:
					"Phased replacement of the aging rooftop package units across all three buildings. Bldg 1 complete, Bldg 2 in progress, Bldg 3 pending curb fabrication.",
				status: "Active",
				priority: "High",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				client_id: client2.id,
				manager_dispatcher_id: dispatcher.id,
				budget: 24000.0,
				starts_at: daysFromNow(-42),
				target_end_at: daysFromNow(38),
			},
		}),
		// P-0002: Active — annual maintenance + retrofit program (Anderson, tax exempt)
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0002",
				name: "Annual Maintenance Program — Anderson Office Complex",
				description:
					"Umbrella project for the FY26 maintenance contract: seasonal PM on all rooftop units plus the floor-by-floor VAV control retrofit.",
				status: "Active",
				priority: "Medium",
				address: client4.address,
				coords: { lat: 43.8334, lon: -91.2601 },
				client_id: client4.id,
				manager_dispatcher_id: dispatcher2.id,
				budget: 6000.0,
				starts_at: daysFromNow(-70),
				target_end_at: daysFromNow(120),
			},
		}),
		// P-0003: Planning — boiler plant replacement (Riverside)
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0003",
				name: "Boiler Plant Replacement — Riverside Apartments",
				description:
					"Full replacement of both aging boilers after the emergency inspection call. Scoping and abatement survey underway; tenant notice required before demolition.",
				status: "Planning",
				priority: "Emergency",
				address: client5.address,
				coords: { lat: 43.8198, lon: -91.2514 },
				client_id: client5.id,
				manager_dispatcher_id: dispatcher.id,
				budget: 32000.0,
				starts_at: daysFromNow(-5),
				target_end_at: daysFromNow(95),
			},
		}),
		// P-0004: Completed — small fleet upgrade that ran slightly over budget
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0004",
				name: "Thermostat Fleet Upgrade — Williams Property Management",
				description:
					"Programmable thermostat rollout across the managed units, with schedule handover to the property team. Came in just over budget after a second unit needed rewiring.",
				status: "Completed",
				priority: "Low",
				address: client3.address,
				coords: { lat: 43.7889, lon: -91.2297 },
				client_id: client3.id,
				manager_dispatcher_id: dispatcher2.id,
				budget: 750.0,
				starts_at: daysFromNow(-48),
				target_end_at: daysFromNow(-28),
				completed_at: daysFromNow(-30),
			},
		}),
		// P-0005: OnHold — awaiting homeowner financing (Johnson)
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0005",
				name: "Whole-Home System Replacement — Johnson Residence",
				description:
					"Heat pump and air handler changeout quoted after the capacitor repair. On hold while the homeowner finalizes financing.",
				status: "OnHold",
				priority: "Medium",
				address: client1.address,
				coords: { lat: 43.8124, lon: -91.2568 },
				client_id: client1.id,
				manager_dispatcher_id: dispatcher.id,
				budget: 11000.0,
				starts_at: daysFromNow(-12),
				target_end_at: daysFromNow(60),
			},
		}),
		// P-0006: Cancelled — never got past scoping, no jobs attached
		db.project.create({
			data: {
				organization_id: org.id,
				project_number: "P-0006",
				name: "Chiller Plant Modernization — Smith Commercial",
				description:
					"Chiller plant modernization with new controls and commissioning. Cancelled before any work orders were written.",
				status: "Cancelled",
				priority: "Urgent",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				client_id: client2.id,
				manager_dispatcher_id: null,
				budget: 48000.0,
				starts_at: daysFromNow(-20),
				target_end_at: daysFromNow(150),
				cancelled_at: daysFromNow(-8),
				cancellation_reason:
					"Owner deferred the capital project to the next budget cycle.",
			},
		}),
	]);

	// ============================================================================
	// Jobs
	// ============================================================================

	const [job1, job2, job3, job4, job5, job6] = await Promise.all([
		// J-0001: Completed — AC repair (Johnson)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0001",
				name: "AC Repair — Johnson Residence",
				description:
					"Diagnose and repair AC unit not producing cold air.",
				priority: "High",
				address: client1.address,
				coords: { lat: 43.8124, lon: -91.2568 },
				status: "Completed",
				client_id: client1.id,
				request_id: req1.id,
				subtotal: 485.0,
				tax_rate: 0.0825,
				tax_amount: 40.01,
				actual_total: 525.01,
				completed_at: daysFromNow(-2),
				line_items: {
					create: [
						{
							name: "Capacitor 45+5 MFD 440V",
							quantity: 1,
							unit_price: 85.0,
							total: 85.0,
							source: "field_addition",
							item_type: "material",
							inventory_item_id: invCapacitor.id,
						},
						{
							name: "Service Labor (2.5 hrs)",
							quantity: 2.5,
							unit_price: 160.0,
							total: 400.0,
							source: "field_addition",
							item_type: "labor",
						},
					],
				},
			},
		}),
		// J-0002: InProgress — rooftop replacement (Smith)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0002",
				name: "Rooftop Unit Replacement — Smith Commercial Bldg 2",
				description:
					"Replace 5-ton rooftop unit per approved quote Q-0001.",
				priority: "Urgent",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				status: "InProgress",
				client_id: client2.id,
				request_id: req2.id,
				quote_id: quote1.id,
				project_id: project1.id,
				subtotal: 6800.0,
				tax_rate: 0.0825,
				tax_amount: 561.0,
				estimated_total: 7361.0,
				line_items: {
					create: [
						{
							name: "Carrier 5-Ton Rooftop Unit 48TCED06A2A5",
							quantity: 1,
							unit_price: 4800.0,
							total: 4800.0,
							source: "quote",
							item_type: "equipment",
						},
						{
							name: "Installation Labor",
							quantity: 8,
							unit_price: 175.0,
							total: 1400.0,
							source: "quote",
							item_type: "labor",
						},
						{
							name: "Refrigerant R-410A (10 lbs)",
							quantity: 10,
							unit_price: 60.0,
							total: 600.0,
							source: "quote",
							item_type: "material",
							inventory_item_id: invRefrigerant.id,
						},
					],
				},
			},
		}),
		// J-0003: Scheduled — annual PM (Anderson)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0003",
				name: "Annual PM — Anderson Office Complex",
				description:
					"Annual preventive maintenance for 3 rooftop units and 12 VAV boxes.",
				priority: "Medium",
				address: client4.address,
				coords: { lat: 43.8334, lon: -91.2601 },
				status: "Scheduled",
				client_id: client4.id,
				project_id: project2.id,
				subtotal: 1200.0,
				tax_rate: 0.0,
				tax_amount: 0.0,
				estimated_total: 1200.0,
				line_items: {
					create: [
						{
							name: "Annual PM Labor (8 hrs)",
							quantity: 8,
							unit_price: 125.0,
							total: 1000.0,
							source: "manual",
							item_type: "labor",
						},
						{
							name: "MERV-13 Filter 20x25x2 (3-pack)",
							quantity: 2,
							unit_price: 45.0,
							total: 90.0,
							source: "manual",
							item_type: "material",
						},
						{
							name: "Miscellaneous Parts Allowance",
							quantity: 1,
							unit_price: 110.0,
							total: 110.0,
							source: "manual",
							item_type: "other",
						},
					],
				},
			},
		}),
		// J-0004: Recurring container — Williams (plan 1)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0004",
				name: "Monthly PM — Williams Property Management",
				description: "Recurring monthly HVAC maintenance contract.",
				priority: "Medium",
				address: client3.address,
				coords: { lat: 43.7889, lon: -91.2297 },
				status: "InProgress",
				client_id: client3.id,
				recurring_plan_id: recurringPlan1.id,
				subtotal: 534.0,
				tax_rate: 0.0825,
				tax_amount: 44.05,
				estimated_total: 578.05,
			},
		}),
		// J-0005: Recurring container — Anderson (plan 2)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0005",
				name: "Weekly Filter Checks — Anderson Office Complex",
				description:
					"Recurring weekly filter inspection and replacement contract.",
				priority: "Low",
				address: client4.address,
				coords: { lat: 43.8334, lon: -91.2601 },
				status: "InProgress",
				client_id: client4.id,
				recurring_plan_id: recurringPlan2.id,
				subtotal: 140.0,
				tax_rate: 0.0,
				tax_amount: 0.0,
				estimated_total: 140.0,
			},
		}),
		// J-0006: Cancelled — emergency boiler inspection (Riverside)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0006",
				name: "Emergency Boiler Inspection — Riverside Apartments",
				description:
					"Tenant reported gas smell near boiler room. Dispatched for immediate inspection.",
				priority: "Emergency",
				address: client5.address,
				coords: { lat: 43.8198, lon: -91.2514 },
				status: "Cancelled",
				client_id: client5.id,
				project_id: project3.id,
				subtotal: 0.0,
				tax_rate: 0.0825,
				tax_amount: 0.0,
				estimated_total: 0.0,
				cancelled_at: daysFromNow(-5),
				cancellation_reason:
					"Gas company responded first and cleared the site. No HVAC work required.",
			},
		}),
	]);

	// Connect quote1 → job2
	await db.quote.update({
		where: { id: quote1.id },
		data: { job: { connect: { id: job2.id } } },
	});

	await Promise.all([
		db.job_note.create({
			data: {
				organization_id: org.id,
				job_id: job1.id,
				content:
					"Technician found failed dual run capacitor. Replaced on-site and topped off refrigerant. System fully operational at completion.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.job_note.create({
			data: {
				organization_id: org.id,
				job_id: job2.id,
				content:
					"Crane access arranged for rooftop. Building management confirmed loading dock available from 7am.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.job_note.create({
			data: {
				organization_id: org.id,
				job_id: job3.id,
				content:
					"Anderson building requires sign-in at main lobby security desk. Tom Davis will meet tech at 8am.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
		db.job_note.create({
			data: {
				organization_id: org.id,
				job_id: job6.id,
				content:
					"Gas company (WE Energies) cleared the scene — minor odor from unrelated water heater vent. No HVAC issue found.",
				creator_dispatcher_id: dispatcher.id,
			},
		}),
	]);

	// ----------------------------------------------------------------------------
	// Project work orders — additional jobs rolled up under the projects above, so
	// each project has a populated jobs list and a meaningful spend-vs-budget bar.
	// Completed jobs carry actual_total, everything else carries estimated_total
	// (the tax post-pass at the end of this file recomputes both from line items).
	// ----------------------------------------------------------------------------

	await Promise.all([
		// J-0007: Completed — P-0001 phase one (Smith Bldg 1)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0007",
				name: "Rooftop Unit Replacement — Smith Commercial Bldg 1",
				description:
					"Phase one of the replacement program: swap the Bldg 1 rooftop package unit and recommission.",
				priority: "High",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				status: "Completed",
				client_id: client2.id,
				project_id: project1.id,
				subtotal: 7450.0,
				tax_rate: 0.0825,
				tax_amount: 614.63,
				actual_total: 8064.63,
				completed_at: daysFromNow(-18),
				line_items: {
					create: [
						{
							name: "Carrier 5-Ton Rooftop Unit 48TCED06A2A5",
							quantity: 1,
							unit_price: 4800.0,
							total: 4800.0,
							source: "manual",
							item_type: "equipment",
						},
						{
							name: "Installation Labor",
							quantity: 8,
							unit_price: 175.0,
							total: 1400.0,
							source: "manual",
							item_type: "labor",
						},
						{
							name: "Crane Rental (half day)",
							quantity: 1,
							unit_price: 650.0,
							total: 650.0,
							source: "manual",
							item_type: "other",
						},
						{
							name: "Refrigerant R-410A (10 lbs)",
							quantity: 10,
							unit_price: 60.0,
							total: 600.0,
							source: "manual",
							item_type: "material",
							inventory_item_id: invRefrigerant.id,
						},
					],
				},
			},
		}),
		// J-0008: Scheduled — P-0001 phase three, blocked on fabrication
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0008",
				name: "Rooftop Curb Adapter Fabrication — Smith Commercial Bldg 3",
				description:
					"Fabricate and set the custom curb adapter so the Bldg 3 unit can drop onto the existing opening.",
				priority: "Medium",
				address: client2.address,
				coords: { lat: 43.8129, lon: -91.2559 },
				status: "Scheduled",
				client_id: client2.id,
				project_id: project1.id,
				subtotal: 2840.0,
				tax_rate: 0.0825,
				tax_amount: 234.3,
				estimated_total: 3074.3,
				line_items: {
					create: [
						{
							name: "Custom Curb Adapter (fabricated)",
							quantity: 1,
							unit_price: 1850.0,
							total: 1850.0,
							source: "manual",
							item_type: "equipment",
						},
						{
							name: "Fabrication & Set Labor",
							quantity: 6,
							unit_price: 165.0,
							total: 990.0,
							source: "manual",
							item_type: "labor",
						},
					],
				},
			},
		}),
		// J-0009: Completed — P-0002 VAV retrofit (Anderson is tax exempt → rate 0)
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0009",
				name: "VAV Box Retrofit — Anderson Office Complex Floor 2",
				description:
					"Replace pneumatic VAV controls with DDC controllers on floor 2; point-to-point checkout with the BAS.",
				priority: "Medium",
				address: client4.address,
				coords: { lat: 43.8334, lon: -91.2601 },
				status: "Completed",
				client_id: client4.id,
				project_id: project2.id,
				subtotal: 3508.0,
				tax_rate: 0.0,
				tax_amount: 0.0,
				actual_total: 3508.0,
				completed_at: daysFromNow(-9),
				line_items: {
					create: [
						{
							name: "DDC Controller",
							quantity: 3,
							unit_price: 520.0,
							total: 1560.0,
							source: "manual",
							item_type: "equipment",
						},
						{
							name: "Control Wire (500ft spool)",
							quantity: 1,
							unit_price: 88.0,
							total: 88.0,
							source: "manual",
							item_type: "material",
						},
						{
							name: "Install & Commissioning Labor",
							quantity: 12,
							unit_price: 155.0,
							total: 1860.0,
							source: "manual",
							item_type: "labor",
						},
					],
				},
			},
		}),
		// J-0010: Unscheduled — P-0003 demolition, waiting on the abatement survey
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0010",
				name: "Boiler Removal & Disposal — Riverside Apartments",
				description:
					"Demolish and haul off both existing boilers once the abatement survey clears the pipe insulation.",
				priority: "Urgent",
				address: client5.address,
				coords: { lat: 43.8198, lon: -91.2514 },
				status: "Unscheduled",
				client_id: client5.id,
				project_id: project3.id,
				subtotal: 3995.0,
				tax_rate: 0.0825,
				tax_amount: 329.59,
				estimated_total: 4324.59,
				line_items: {
					create: [
						{
							name: "Demolition Labor",
							quantity: 16,
							unit_price: 160.0,
							total: 2560.0,
							source: "manual",
							item_type: "labor",
						},
						{
							name: "Asbestos Abatement Survey",
							quantity: 1,
							unit_price: 950.0,
							total: 950.0,
							source: "manual",
							item_type: "other",
						},
						{
							name: "Disposal & Haul-Off",
							quantity: 1,
							unit_price: 485.0,
							total: 485.0,
							source: "manual",
							item_type: "other",
						},
					],
				},
			},
		}),
		// J-0011: Completed — P-0004 unit 4
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0011",
				name: "Thermostat Replacement — Williams Unit 4",
				description:
					"Swap the failed thermostat for a programmable model and commission the schedule.",
				priority: "Low",
				address: client3.address,
				coords: { lat: 43.7889, lon: -91.2297 },
				status: "Completed",
				client_id: client3.id,
				project_id: project4.id,
				subtotal: 406.5,
				tax_rate: 0.0825,
				tax_amount: 33.54,
				actual_total: 440.04,
				completed_at: daysFromNow(-34),
				line_items: {
					create: [
						{
							name: "Programmable Thermostat",
							quantity: 1,
							unit_price: 189.0,
							total: 189.0,
							source: "manual",
							item_type: "equipment",
							inventory_item_id: invThermostat.id,
						},
						{
							name: "Service Labor (1.5 hrs)",
							quantity: 1.5,
							unit_price: 145.0,
							total: 217.5,
							source: "manual",
							item_type: "labor",
						},
					],
				},
			},
		}),
		// J-0012: Completed — P-0004 unit 9, the rewire that pushed it over budget
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0012",
				name: "Thermostat Replacement — Williams Unit 9",
				description:
					"Thermostat swap plus a low-voltage rewire — the original run was spliced and unusable.",
				priority: "Low",
				address: client3.address,
				coords: { lat: 43.7889, lon: -91.2297 },
				status: "Completed",
				client_id: client3.id,
				project_id: project4.id,
				subtotal: 406.5,
				tax_rate: 0.0825,
				tax_amount: 33.54,
				actual_total: 440.04,
				completed_at: daysFromNow(-31),
				line_items: {
					create: [
						{
							name: "Programmable Thermostat",
							quantity: 1,
							unit_price: 189.0,
							total: 189.0,
							source: "manual",
							item_type: "equipment",
							inventory_item_id: invThermostat.id,
						},
						{
							name: "Service Labor (1.5 hrs)",
							quantity: 1.5,
							unit_price: 145.0,
							total: 217.5,
							source: "field_addition",
							item_type: "labor",
						},
					],
				},
			},
		}),
		// J-0013: Unscheduled — P-0005, the changeout the homeowner has on hold
		db.job.create({
			data: {
				organization_id: org.id,
				job_number: "J-0013",
				name: "Heat Pump & Air Handler Changeout — Johnson Residence",
				description:
					"Replace the aging split system with a 3-ton heat pump and matched air handler; new line set and pad.",
				priority: "Medium",
				address: client1.address,
				coords: { lat: 43.8124, lon: -91.2568 },
				status: "Unscheduled",
				client_id: client1.id,
				project_id: project5.id,
				subtotal: 9955.0,
				tax_rate: 0.0825,
				tax_amount: 821.29,
				estimated_total: 10776.29,
				line_items: {
					create: [
						{
							name: "Trane 3-Ton Heat Pump XR15",
							quantity: 1,
							unit_price: 5400.0,
							total: 5400.0,
							source: "manual",
							item_type: "equipment",
						},
						{
							name: "Air Handler w/ Matched Coil",
							quantity: 1,
							unit_price: 1980.0,
							total: 1980.0,
							source: "manual",
							item_type: "equipment",
						},
						{
							name: "Installation Labor",
							quantity: 14,
							unit_price: 165.0,
							total: 2310.0,
							source: "manual",
							item_type: "labor",
						},
						{
							name: "Line Set & Equipment Pad Kit",
							quantity: 1,
							unit_price: 265.0,
							total: 265.0,
							source: "manual",
							item_type: "material",
						},
					],
				},
			},
		}),
	]);

	// ============================================================================
	// Job Visits
	// ============================================================================

	const yesterday = daysFromNow(-1);
	const today = new Date();
	const tomorrow = daysFromNow(1);
	const nextWeek = daysFromNow(7);

	// Visit 1: Completed — job1 AC repair (inventory-linked capacitor)
	const visit1 = await db.job_visit.create({
		data: {
			job_id: job1.id,
			name: "AC Diagnosis & Repair",
			description: "Diagnose cooling issue, replace failed capacitor.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "09:00",
			scheduled_start_at: dateAt(yesterday, 9),
			scheduled_end_at: dateAt(yesterday, 12),
			actual_start_at: dateAt(yesterday, 9, 15),
			actual_end_at: dateAt(yesterday, 11, 30),
			status: "Completed",
			subtotal: 485.0,
			tax_rate: 0.0825,
			tax_amount: 40.01,
			total: 525.01,
			visit_techs: { create: { tech_id: tech2.id } },
			line_items: {
				create: [
					{
						name: "Capacitor 45+5 MFD 440V",
						quantity: 1,
						unit_price: 85.0,
						total: 85.0,
						source: "field_addition",
						item_type: "material",
						sort_order: 0,
						inventory_item_id: invCapacitor.id,
					},
					{
						name: "Service Labor (2.5 hrs)",
						quantity: 2.5,
						unit_price: 160.0,
						total: 400.0,
						source: "field_addition",
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	await db.job_note.create({
		data: {
			organization_id: org.id,
			job_id: job1.id,
			visit_id: visit1.id,
			content:
				"Arrived on time. Capacitor tested at 38+3.8 MFD (spec: 45+5). Replaced and recharged 1 lb R-410A. Customer signed off.",
			creator_tech_id: tech2.id,
		},
	});

	// Visit 2: OnSite — job2 rooftop installation (inventory-linked refrigerant)
	const visit2 = await db.job_visit.create({
		data: {
			job_id: job2.id,
			name: "Equipment Removal & Installation",
			description: "Remove old unit, install new Carrier 48TCED06A2A5.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "07:00",
			scheduled_start_at: dateAt(today, 7),
			scheduled_end_at: dateAt(today, 17),
			actual_start_at: actualAt(today, 7, 10, 45),
			status: "OnSite",
			subtotal: 6800.0,
			tax_rate: 0.0825,
			tax_amount: 561.0,
			total: 7361.0,
			visit_techs: {
				create: [{ tech_id: tech1.id }, { tech_id: tech2.id }],
			},
			line_items: {
				create: [
					{
						name: "Carrier 5-Ton Rooftop Unit 48TCED06A2A5",
						quantity: 1,
						unit_price: 4800.0,
						total: 4800.0,
						source: "quote",
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Installation Labor",
						quantity: 8,
						unit_price: 175.0,
						total: 1400.0,
						source: "quote",
						item_type: "labor",
						sort_order: 1,
					},
					{
						name: "Refrigerant R-410A (10 lbs)",
						quantity: 10,
						unit_price: 60.0,
						total: 600.0,
						source: "quote",
						item_type: "material",
						sort_order: 2,
						inventory_item_id: invRefrigerant.id,
					},
				],
			},
		},
	});

	// Visit 3: Scheduled — job3 annual PM (Anderson, next week)
	const visit3 = await db.job_visit.create({
		data: {
			job_id: job3.id,
			name: "Annual PM — Rooftop Units & VAV Boxes",
			description:
				"Full annual PM: clean coils, replace filters, test all VAV boxes, check refrigerant levels.",
			arrival_constraint: "between",
			finish_constraint: "when_done",
			arrival_window_start: "08:00",
			arrival_window_end: "09:00",
			scheduled_start_at: dateAt(nextWeek, 8),
			scheduled_end_at: dateAt(nextWeek, 14),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
			line_items: {
				create: [
					{
						name: "Annual PM Labor (8 hrs)",
						quantity: 8,
						unit_price: 125.0,
						total: 1000.0,
						source: "manual",
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "MERV-13 Filter 20x25x2 (3-pack)",
						quantity: 2,
						unit_price: 45.0,
						total: 90.0,
						source: "manual",
						item_type: "material",
						sort_order: 1,
					},
					{
						name: "Miscellaneous Parts Allowance",
						quantity: 1,
						unit_price: 110.0,
						total: 110.0,
						source: "manual",
						item_type: "other",
						sort_order: 2,
					},
				],
			},
		},
	});

	// Visit 4: Completed — plan1 recurring (last month, inventory-linked filter)
	const recurringVisit1 = await db.job_visit.create({
		data: {
			job_id: job4.id,
			name: "Monthly PM — Williams Properties",
			description:
				"Monthly filter replacement and system inspection across all units.",
			arrival_constraint: "between",
			finish_constraint: "when_done",
			arrival_window_start: "08:00",
			arrival_window_end: "09:00",
			scheduled_start_at: occurrencePastStart,
			scheduled_end_at: occurrencePastEnd,
			actual_start_at: dateAt(occurrencePastStart, 8, 5),
			actual_end_at: dateAt(occurrencePastStart, 11, 50),
			status: "Completed",
			subtotal: 534.0,
			tax_rate: 0.0825,
			tax_amount: 44.05,
			total: 578.05,
			visit_techs: { create: { tech_id: tech1.id } },
			line_items: {
				create: [
					{
						name: "PM Labor (4 hrs)",
						quantity: 4,
						unit_price: 125.0,
						total: 500.0,
						source: "recurring_plan",
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Air Filter 16x25x1 MERV-8 (4-pack)",
						quantity: 4,
						unit_price: 8.5,
						total: 34.0,
						source: "recurring_plan",
						item_type: "material",
						sort_order: 1,
						inventory_item_id: invFilter.id,
					},
				],
			},
		},
	});

	// Visit 5: Completed — plan2 weekly (last week, tech3)
	const weeklyVisit1 = await db.job_visit.create({
		data: {
			job_id: job5.id,
			name: "Weekly Filter Check — Anderson Office",
			description:
				"Inspect and replace MERV-13 filters in all 3 rooftop units.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "07:00",
			scheduled_start_at: weeklyOccStart1,
			scheduled_end_at: weeklyOccEnd1,
			actual_start_at: dateAt(weeklyOccStart1, 7, 5),
			actual_end_at: dateAt(weeklyOccStart1, 8, 45),
			status: "Completed",
			subtotal: 140.0,
			tax_rate: 0.0,
			tax_amount: 0.0,
			total: 140.0,
			visit_techs: { create: { tech_id: tech3.id } },
			line_items: {
				create: [
					{
						name: "Filter Inspection Labor (1 hr)",
						quantity: 1,
						unit_price: 95.0,
						total: 95.0,
						source: "recurring_plan",
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "MERV-13 Filter 20x25x2 (3-pack)",
						quantity: 1,
						unit_price: 45.0,
						total: 45.0,
						source: "recurring_plan",
						item_type: "material",
						sort_order: 1,
					},
				],
			},
		},
	});

	// Visit 6: Scheduled — plan2 weekly (next week, generated occurrence)
	const weeklyVisit2 = await db.job_visit.create({
		data: {
			job_id: job5.id,
			name: "Weekly Filter Check — Anderson Office",
			description:
				"Inspect and replace MERV-13 filters in all 3 rooftop units.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "07:00",
			scheduled_start_at: weeklyOccStart2,
			scheduled_end_at: weeklyOccEnd2,
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech3.id } },
		},
	});

	// Visit 7: Driving — tech3 en route to job3 pre-check (Driving status)
	const visit7 = await db.job_visit.create({
		data: {
			job_id: job3.id,
			name: "Pre-Inspection Site Survey",
			description:
				"Quick site survey to confirm scope before scheduled annual PM.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "10:00",
			scheduled_start_at: dateAt(today, 10),
			scheduled_end_at: dateAt(today, 11),
			actual_start_at: actualAt(today, 9, 50, 10),
			status: "Driving",
			visit_techs: { create: { tech_id: tech3.id } },
		},
	});

	// Visit 8: Paused — job4 recurring PM mid-work (Paused status)
	const visit8 = await db.job_visit.create({
		data: {
			job_id: job4.id,
			name: "Emergency Coil Cleaning — Unit 2",
			description:
				"Unscheduled coil cleaning discovered during routine inspection.",
			arrival_constraint: "anytime",
			finish_constraint: "when_done",
			scheduled_start_at: dateAt(today, 13),
			scheduled_end_at: dateAt(today, 15),
			actual_start_at: actualAt(today, 13, 5, 95),
			status: "Paused",
			visit_techs: { create: { tech_id: tech1.id } },
			line_items: {
				create: [
					{
						name: "Coil Cleaning Labor (1.5 hrs)",
						quantity: 1.5,
						unit_price: 125.0,
						total: 187.5,
						source: "field_addition",
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Coil Cleaner Solution",
						quantity: 1,
						unit_price: 22.0,
						total: 22.0,
						source: "field_addition",
						item_type: "material",
						sort_order: 1,
					},
				],
			},
		},
	});

	// Visit 9: Delayed — the other visit off-ramp. Its window opened this
	// morning and nobody has started it.
	await db.job_visit.create({
		data: {
			job_id: job3.id,
			name: "Rooftop Unit Access Check",
			description: "Confirm roof hatch access before the annual PM crew arrives.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "08:00",
			scheduled_start_at: dateAt(today, 8),
			scheduled_end_at: dateAt(today, 9),
			status: "Delayed",
			visit_techs: { create: { tech_id: tech2.id } },
		},
	});

	await db.job_note.create({
		data: {
			organization_id: org.id,
			job_id: job4.id,
			visit_id: recurringVisit1.id,
			content:
				"All 4 units serviced. Unit 3 had a slightly dirty evaporator coil — cleaned on-site. No refrigerant issues.",
			creator_tech_id: tech1.id,
		},
	});

	// ============================================================================
	// John Smith — Today + Tomorrow visits for dashboard testing
	// Dates computed at seed time so they're always current on DB reinit
	// ============================================================================

	// Today 1: Scheduled morning (active/next visit on dashboard)
	const todayFilterVisit = await db.job_visit.create({
		data: {
			job_id: job3.id,
			name: "Filter Replacement — Anderson Bldg A",
			description:
				"Replace MERV-8 filters in all first-floor air handlers.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "08:00",
			scheduled_start_at: dateAt(today, 8),
			scheduled_end_at: dateAt(today, 10),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
			line_items: {
				create: [
					{
						name: "Filter Replacement Labor (2 hrs)",
						quantity: 2,
						unit_price: 95.0,
						total: 190.0,
						source: "manual",
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Air Filter 16x25x1 MERV-8 (6-pack)",
						quantity: 6,
						unit_price: 8.5,
						total: 51.0,
						source: "manual",
						item_type: "material",
						sort_order: 1,
						inventory_item_id: invFilter.id,
					},
				],
			},
		},
	});

	// Today 2: Scheduled midday
	const todayFollowUpVisit = await db.job_visit.create({
		data: {
			job_id: job1.id,
			name: "Follow-Up AC Check — Johnson Residence",
			description:
				"Post-repair verification — confirm system holding pressure and cooling properly.",
			arrival_constraint: "between",
			finish_constraint: "when_done",
			arrival_window_start: "11:00",
			arrival_window_end: "12:00",
			scheduled_start_at: dateAt(today, 11),
			scheduled_end_at: dateAt(today, 12, 30),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
		},
	});

	// Today 3: Anytime — tests "Anytime today" label + sorted to end of list
	await db.job_visit.create({
		data: {
			job_id: job4.id,
			name: "Thermostat Calibration — Williams Unit 7",
			description:
				"Customer reports thermostat overshooting. Anytime access — key in lockbox.",
			arrival_constraint: "anytime",
			finish_constraint: "when_done",
			scheduled_start_at: dateAt(today, 0),
			scheduled_end_at: dateAt(today, 23, 59),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
		},
	});

	// Tomorrow 1: Scheduled morning — appears in condensed tomorrow row
	await db.job_visit.create({
		data: {
			job_id: job3.id,
			name: "Annual PM — Anderson Bldg B Rooftop Unit",
			description:
				"Rooftop unit coil cleaning, refrigerant check, and belt inspection.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "09:00",
			scheduled_start_at: dateAt(tomorrow, 9),
			scheduled_end_at: dateAt(tomorrow, 13),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
			line_items: {
				create: [
					{
						name: "PM Labor (4 hrs)",
						quantity: 4,
						unit_price: 125.0,
						total: 500.0,
						source: "manual",
						item_type: "labor",
						sort_order: 0,
					},
				],
			},
		},
	});

	// Tomorrow 2: Scheduled afternoon — causes "+1 more" on dashboard tomorrow row
	await db.job_visit.create({
		data: {
			job_id: job5.id,
			name: "Condenser Coil Cleaning — Anderson Unit 2",
			description:
				"Annual coil cleaning and system check for Unit 2 condenser.",
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "14:00",
			scheduled_start_at: dateAt(tomorrow, 14),
			scheduled_end_at: dateAt(tomorrow, 16),
			status: "Scheduled",
			visit_techs: { create: { tech_id: tech1.id } },
		},
	});

	// ============================================================================
	// Recurring Occurrences
	// ============================================================================

	await Promise.all([
		// Plan 1 — skipped (3 months ago, holiday conflict)
		db.recurring_occurrence.create({
			data: {
				recurring_plan_id: recurringPlan1.id,
				occurrence_start_at: occurrenceSkippedStart,
				occurrence_end_at: occurrenceSkippedEnd,
				status: "skipped",
				skipped_at: occurrenceSkippedStart,
				skip_reason:
					"New Year's holiday — building closed. Rescheduled maintenance folded into February visit.",
				generated_at: daysFromNow(-100),
				arrival_constraint: "between",
				finish_constraint: "when_done",
				arrival_window_start: "08:00",
				arrival_window_end: "09:00",
			},
		}),
		// Plan 1 — completed (last month)
		db.recurring_occurrence.create({
			data: {
				recurring_plan_id: recurringPlan1.id,
				occurrence_start_at: occurrencePastStart,
				occurrence_end_at: occurrencePastEnd,
				status: "completed",
				job_visit_id: recurringVisit1.id,
				generated_at: daysFromNow(-45),
				completed_at: dateAt(occurrencePastStart, 11, 50),
				arrival_constraint: "between",
				finish_constraint: "when_done",
				arrival_window_start: "08:00",
				arrival_window_end: "09:00",
			},
		}),
		// Plan 1 — planned (next month)
		db.recurring_occurrence.create({
			data: {
				recurring_plan_id: recurringPlan1.id,
				occurrence_start_at: occurrenceFutureStart,
				occurrence_end_at: occurrenceFutureEnd,
				status: "planned",
				arrival_constraint: "between",
				finish_constraint: "when_done",
				arrival_window_start: "08:00",
				arrival_window_end: "09:00",
			},
		}),
		// Plan 2 — completed (last week)
		db.recurring_occurrence.create({
			data: {
				recurring_plan_id: recurringPlan2.id,
				occurrence_start_at: weeklyOccStart1,
				occurrence_end_at: weeklyOccEnd1,
				status: "completed",
				job_visit_id: weeklyVisit1.id,
				generated_at: daysFromNow(-14),
				completed_at: dateAt(weeklyOccStart1, 8, 45),
				arrival_constraint: "at",
				finish_constraint: "when_done",
				arrival_time: "07:00",
			},
		}),
		// Plan 2 — generated (next week, linked to scheduled visit)
		db.recurring_occurrence.create({
			data: {
				recurring_plan_id: recurringPlan2.id,
				occurrence_start_at: weeklyOccStart2,
				occurrence_end_at: weeklyOccEnd2,
				status: "generated",
				job_visit_id: weeklyVisit2.id,
				generated_at: daysFromNow(-7),
				arrival_constraint: "at",
				finish_constraint: "when_done",
				arrival_time: "07:00",
			},
		}),
	]);

	// ============================================================================
	// Invoices
	// ============================================================================

	// INV-0001: Paid — AC repair (Johnson)
	const invoice1 = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0001",
			client_id: client1.id,
			status: "Paid",
			issue_date: daysFromNow(-2),
			due_date: daysFromNow(28),
			payment_terms_days: 30,
			paid_at: daysFromNow(-1),
			subtotal: 485.0,
			tax_rate: 0.0825,
			tax_amount: 40.01,
			total: 525.01,
			amount_paid: 525.01,
			balance_due: 0.0,
			memo: "Thank you for your business!",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_visit_id: visit1.id,
						name: "Capacitor 45+5 MFD 440V",
						quantity: 1,
						unit_price: 85.0,
						total: 85.0,
						item_type: "material",
						inventory_item_id: invCapacitor.id,
						sort_order: 0,
					},
					{
						source_visit_id: visit1.id,
						name: "Service Labor (2.5 hrs)",
						quantity: 2.5,
						unit_price: 160.0,
						total: 400.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
			// Matches syncBilledAmounts: visit-sourced lines bill the visit, and the
			// job row carries only job-level lines — pre-tax, never both.
			jobs: { create: { job_id: job1.id, billed_amount: 0.0 } },
			visits: { create: { visit_id: visit1.id, billed_amount: 485.0 } },
		},
	});

	await db.invoice_payment.create({
		data: {
			invoice_id: invoice1.id,
			amount: 525.01,
			paid_at: daysFromNow(-1),
			method: "Check",
			note: "Check #4471 received from Robert Johnson.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	await db.invoice_note.create({
		data: {
			organization_id: org.id,
			invoice_id: invoice1.id,
			content:
				"Payment received via check day after service. Customer very satisfied with the quick turnaround.",
			creator_dispatcher_id: dispatcher.id,
		},
	});

	// INV-0002: Draft — monthly PM (Williams)
	await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0002",
			client_id: client3.id,
			recurring_plan_id: recurringPlan1.id,
			status: "Draft",
			issue_date: occurrencePastStart,
			due_date: new Date(
				occurrencePastStart.getTime() + 30 * 24 * 60 * 60 * 1000,
			),
			payment_terms_days: 30,
			subtotal: 534.0,
			tax_rate: 0.0825,
			tax_amount: 44.05,
			total: 578.05,
			amount_paid: 0.0,
			balance_due: 578.05,
			memo: "Monthly HVAC maintenance services — Williams Properties.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_visit_id: recurringVisit1.id,
						name: "PM Labor (4 hrs)",
						quantity: 4,
						unit_price: 125.0,
						total: 500.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						source_visit_id: recurringVisit1.id,
						name: "Air Filter 16x25x1 MERV-8 (4-pack)",
						quantity: 4,
						unit_price: 8.5,
						total: 34.0,
						item_type: "material",
						inventory_item_id: invFilter.id,
						sort_order: 1,
					},
				],
			},
			jobs: { create: { job_id: job4.id, billed_amount: 0.0 } },
			visits: {
				create: { visit_id: recurringVisit1.id, billed_amount: 534.0 },
			},
		},
	});

	// INV-0003: Sent — equipment deposit for rooftop job (Smith)
	await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0003",
			client_id: client2.id,
			status: "Sent",
			issue_date: daysFromNow(-3),
			due_date: daysFromNow(27),
			payment_terms_days: 30,
			sent_at: daysFromNow(-3),
			viewed_at: daysFromNow(-2),
			subtotal: 4800.0,
			tax_rate: 0.0825,
			tax_amount: 396.0,
			total: 5196.0,
			amount_paid: 0.0,
			balance_due: 5196.0,
			memo: "Equipment deposit — Carrier 48TCED06A2A5. Labor invoiced separately upon installation completion.",
			internal_notes:
				"Per contract terms: equipment cost billed upfront. Labor invoice to follow on job completion.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_job_id: job2.id,
						name: "Carrier 5-Ton Rooftop Unit 48TCED06A2A5 (Equipment Deposit)",
						quantity: 1,
						unit_price: 4800.0,
						total: 4800.0,
						item_type: "equipment",
						sort_order: 0,
					},
				],
			},
			jobs: { create: { job_id: job2.id, billed_amount: 4800.0 } },
		},
	});

	// INV-0004: PartiallyPaid — annual PM pre-billed (Anderson, tax exempt)
	const invoice4 = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0004",
			client_id: client4.id,
			status: "PartiallyPaid",
			issue_date: daysFromNow(-14),
			due_date: daysFromNow(16),
			payment_terms_days: 30,
			sent_at: daysFromNow(-14),
			subtotal: 1200.0,
			tax_rate: 0.0,
			tax_amount: 0.0,
			total: 1200.0,
			amount_paid: 600.0,
			balance_due: 600.0,
			memo: "Annual preventive maintenance — Anderson Office Complex.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_visit_id: visit3.id,
						name: "Annual PM Labor (8 hrs)",
						quantity: 8,
						unit_price: 125.0,
						total: 1000.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						source_visit_id: visit3.id,
						name: "MERV-13 Filter 20x25x2 (3-pack)",
						quantity: 2,
						unit_price: 45.0,
						total: 90.0,
						item_type: "material",
						sort_order: 1,
					},
					{
						source_visit_id: visit3.id,
						name: "Miscellaneous Parts Allowance",
						quantity: 1,
						unit_price: 110.0,
						total: 110.0,
						item_type: "other",
						sort_order: 2,
					},
				],
			},
			jobs: { create: { job_id: job3.id, billed_amount: 0.0 } },
			visits: { create: { visit_id: visit3.id, billed_amount: 1200.0 } },
		},
	});

	await db.invoice_payment.create({
		data: {
			invoice_id: invoice4.id,
			amount: 600.0,
			paid_at: daysFromNow(-7),
			method: "ACH",
			note: "First installment per payment arrangement with Michael Anderson.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	await db.invoice_note.create({
		data: {
			organization_id: org.id,
			invoice_id: invoice4.id,
			content:
				"Anderson agreed to split into two $600 installments. Second payment due by end of month.",
			creator_dispatcher_id: dispatcher.id,
		},
	});

	// ============================================================================
	// Form Drafts
	// ============================================================================

	await Promise.all([
		db.form_draft.create({
			data: {
				organization_id: org.id,
				form_type: "quote",
				label: "Q — Riverside Apts: Boiler Inspection & Tune-Up",
				entity_context_id: req4.id,
				payload: {
					title: "Boiler Inspection & Tune-Up — Riverside Apartments",
					client_id: client5.id,
					request_id: req4.id,
					description:
						"Full boiler inspection, combustion analysis, and safety check for heating season.",
					priority: "Medium",
					address: "1420 Rose St, La Crosse, WI 54603",
					tax_rate: 0.0825,
					line_items: [
						{
							name: "Boiler Inspection & Combustion Analysis",
							quantity: 1,
							unit_price: 195.0,
							item_type: "labor",
						},
						{
							name: "Tune-Up Kit (filters, gaskets, igniter)",
							quantity: 1,
							unit_price: 55.0,
							item_type: "material",
						},
					],
				},
			},
		}),
		db.form_draft.create({
			data: {
				organization_id: org.id,
				form_type: "job_visit",
				label: "Visit — J-0003: Final Commissioning",
				entity_context_id: job3.id,
				payload: {
					job_id: job3.id,
					name: "Final Commissioning & Customer Walkthrough",
					description:
						"Commission all repaired systems, verify operation with building manager, conduct walkthrough.",
					arrival_constraint: "at",
					finish_constraint: "when_done",
					arrival_time: "14:00",
					tech_ids: [tech1.id],
				},
			},
		}),
		db.form_draft.create({
			data: {
				organization_id: org.id,
				form_type: "invoice",
				label: "INV — Smith Commercial: J-0002 Labor Completion",
				entity_context_id: job2.id,
				payload: {
					client_id: client2.id,
					job_id: job2.id,
					memo: "Installation labor upon rooftop unit completion. Equipment billed separately on INV-0003.",
					payment_terms_days: 30,
					line_items: [
						{
							name: "Installation Labor (8 hrs)",
							quantity: 8,
							unit_price: 175.0,
							item_type: "labor",
						},
						{
							name: "Refrigerant R-410A (10 lbs)",
							quantity: 10,
							unit_price: 60.0,
							item_type: "material",
						},
					],
				},
			},
		}),
	]);

	// ============================================================================
	// Activity Logs  (populates the live activity feed on first load)
	// Each entry matches a FEED_EVENT type consumed by /logs/recent
	// ============================================================================

	const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
	const hrsAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

	await db.log.createMany({
		data: [
			// ── Requests ────────────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "request.created",
				action: "created",
				entity_type: "request",
				entity_id: req5.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					title: { old: null, new: "Duct Cleaning — Full House" },
					priority: { old: null, new: "Low" },
				},
				timestamp: hrsAgo(336),
			},
			{
				organization_id: org.id,
				event_type: "request.created",
				action: "created",
				entity_type: "request",
				entity_id: req2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					title: { old: null, new: "Furnace Not Starting" },
					priority: { old: null, new: "Urgent" },
				},
				timestamp: hrsAgo(300),
			},
			{
				organization_id: org.id,
				event_type: "request.created",
				action: "created",
				entity_type: "request",
				entity_id: req1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					title: { old: null, new: "AC Not Cooling" },
					priority: { old: null, new: "High" },
				},
				timestamp: hrsAgo(264),
			},
			{
				organization_id: org.id,
				event_type: "request.created",
				action: "created",
				entity_type: "request",
				entity_id: req4.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					title: {
						old: null,
						new: "Thermostat Replacement — Units 4, 8, 12",
					},
					priority: { old: null, new: "Medium" },
				},
				timestamp: hrsAgo(240),
			},
			// ── Quotes ──────────────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "quote.created",
				action: "created",
				entity_type: "quote",
				entity_id: quote1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					quote_number: { old: null, new: "Q-0001" },
					title: {
						old: null,
						new: "Rooftop Unit Replacement — Bldg 2",
					},
					total: { old: null, new: 7361.0 },
				},
				timestamp: hrsAgo(228),
			},
			{
				organization_id: org.id,
				event_type: "quote.updated",
				action: "updated",
				entity_type: "quote",
				entity_id: quote1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					status: { old: "Draft", new: "Sent" },
					_quote_number: { old: null, new: "Q-0001" },
				},
				timestamp: hrsAgo(216),
			},
			{
				organization_id: org.id,
				event_type: "quote.created",
				action: "created",
				entity_type: "quote",
				entity_id: quote2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					quote_number: { old: null, new: "Q-0002" },
					title: {
						old: null,
						new: "Thermostat Replacement — Riverside Apts Units 4, 8, 12",
					},
					total: { old: null, new: 292.28 },
				},
				timestamp: hrsAgo(192),
			},
			{
				organization_id: org.id,
				event_type: "quote.updated",
				action: "updated",
				entity_type: "quote",
				entity_id: quote1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					status: { old: "Sent", new: "Approved" },
					_quote_number: { old: null, new: "Q-0001" },
				},
				timestamp: hrsAgo(144),
			},
			// ── Recurring Plans ─────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "recurring_plan.created",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: recurringPlan1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					name: {
						old: null,
						new: "Monthly HVAC Maintenance — Williams Properties",
					},
				},
				timestamp: hrsAgo(192),
			},
			{
				organization_id: org.id,
				event_type: "recurring_plan.created",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: recurringPlan2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					name: {
						old: null,
						new: "Weekly Filter Checks — Anderson Office Complex",
					},
				},
				timestamp: hrsAgo(190),
			},
			// ── Jobs ────────────────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "job.created",
				action: "created",
				entity_type: "job",
				entity_id: job1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_number: { old: null, new: "J-0001" },
					name: { old: null, new: "AC Repair — Johnson Residence" },
				},
				timestamp: hrsAgo(216),
			},
			{
				organization_id: org.id,
				event_type: "job.created",
				action: "created",
				entity_type: "job",
				entity_id: job2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_number: { old: null, new: "J-0002" },
					name: {
						old: null,
						new: "Rooftop Unit Replacement — Smith Commercial Bldg 2",
					},
				},
				timestamp: hrsAgo(168),
			},
			{
				organization_id: org.id,
				event_type: "job.created",
				action: "created",
				entity_type: "job",
				entity_id: job3.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_number: { old: null, new: "J-0003" },
					name: {
						old: null,
						new: "Annual PM — Anderson Office Complex",
					},
				},
				timestamp: hrsAgo(167),
			},
			// ── Recurring occurrences ────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "recurring_occurrence.generated",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: recurringPlan1.id,
				actor_type: "system",
				actor_id: null,
				actor_name: "System",
				changes: { generated_count: { old: 0, new: 1 } },
				timestamp: hrsAgo(120),
			},
			{
				organization_id: org.id,
				event_type: "recurring_occurrence.generated",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: recurringPlan2.id,
				actor_type: "system",
				actor_id: null,
				actor_name: "System",
				changes: { generated_count: { old: 0, new: 1 } },
				timestamp: hrsAgo(110),
			},
			// ── Visit lifecycle ──────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "job_visit.created",
				action: "created",
				entity_type: "job_visit",
				entity_id: recurringVisit1.id,
				actor_type: "system",
				actor_id: null,
				actor_name: "System",
				changes: {
					job_id: { old: null, new: job4.id },
					_job_number: { old: null, new: "J-0004" },
					name: {
						old: null,
						new: "Monthly PM — Williams Properties",
					},
					scheduled_start_at: {
						old: null,
						new: occurrencePastStart.toISOString(),
					},
				},
				timestamp: hrsAgo(120),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.technicians_assigned",
				action: "updated",
				entity_type: "job_visit",
				entity_id: recurringVisit1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					technicians: { old: [], new: [tech1.name] },
					_job_id: { old: null, new: job4.id },
					_job_number: { old: null, new: "J-0004" },
				},
				timestamp: hrsAgo(119),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.created",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
					name: { old: null, new: "AC Diagnosis & Repair" },
					scheduled_start_at: {
						old: null,
						new: dateAt(yesterday, 9).toISOString(),
					},
				},
				timestamp: hrsAgo(48),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.technicians_assigned",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					technicians: { old: [], new: [tech2.name] },
					_job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
				},
				timestamp: hrsAgo(47),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "technician",
				actor_id: tech2.id,
				actor_name: tech2.name,
				changes: {
					status: { old: "Scheduled", new: "Driving" },
					_job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
				},
				timestamp: hrsAgo(35),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "technician",
				actor_id: tech2.id,
				actor_name: tech2.name,
				changes: {
					status: { old: "Driving", new: "OnSite" },
					_job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
				},
				timestamp: hrsAgo(34),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "technician",
				actor_id: tech2.id,
				actor_name: tech2.name,
				changes: {
					status: { old: "OnSite", new: "InProgress" },
					_job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
				},
				timestamp: hrsAgo(34),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit1.id,
				actor_type: "technician",
				actor_id: tech2.id,
				actor_name: tech2.name,
				changes: {
					status: { old: "InProgress", new: "Completed" },
					_job_id: { old: null, new: job1.id },
					_job_number: { old: null, new: "J-0001" },
				},
				timestamp: hrsAgo(32),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.created",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_id: { old: null, new: job2.id },
					_job_number: { old: null, new: "J-0002" },
					name: {
						old: null,
						new: "Equipment Removal & Installation",
					},
					scheduled_start_at: {
						old: null,
						new: dateAt(today, 7).toISOString(),
					},
				},
				timestamp: hrsAgo(24),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.technicians_assigned",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit2.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					technicians: { old: [], new: [tech1.name, tech2.name] },
					_job_id: { old: null, new: job2.id },
					_job_number: { old: null, new: "J-0002" },
				},
				timestamp: hrsAgo(23),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit2.id,
				actor_type: "technician",
				actor_id: tech1.id,
				actor_name: tech1.name,
				changes: {
					status: { old: "Scheduled", new: "Driving" },
					_job_id: { old: null, new: job2.id },
					_job_number: { old: null, new: "J-0002" },
				},
				timestamp: hrsAgo(5),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit2.id,
				actor_type: "technician",
				actor_id: tech1.id,
				actor_name: tech1.name,
				changes: {
					status: { old: "Driving", new: "OnSite" },
					_job_id: { old: null, new: job2.id },
					_job_number: { old: null, new: "J-0002" },
				},
				timestamp: hrsAgo(4),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.created",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit7.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					job_id: { old: null, new: job3.id },
					_job_number: { old: null, new: "J-0003" },
					name: { old: null, new: "Pre-Inspection Site Survey" },
					scheduled_start_at: {
						old: null,
						new: dateAt(today, 10).toISOString(),
					},
				},
				timestamp: hrsAgo(3),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit7.id,
				actor_type: "technician",
				actor_id: tech3.id,
				actor_name: tech3.name,
				changes: {
					status: { old: "Scheduled", new: "Driving" },
					_job_id: { old: null, new: job3.id },
					_job_number: { old: null, new: "J-0003" },
				},
				timestamp: minsAgo(45),
			},
			{
				organization_id: org.id,
				event_type: "job_visit.updated",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit8.id,
				actor_type: "technician",
				actor_id: tech1.id,
				actor_name: tech1.name,
				changes: {
					status: { old: "InProgress", new: "Paused" },
					_job_id: { old: null, new: job4.id },
					_job_number: { old: null, new: "J-0004" },
				},
				timestamp: minsAgo(20),
			},
			// ── Invoices ─────────────────────────────────────────────────────────
			{
				organization_id: org.id,
				event_type: "invoice.created",
				action: "created",
				entity_type: "invoice",
				entity_id: invoice1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					invoice_number: { old: null, new: "INV-0001" },
					total: { old: null, new: 525.01 },
				},
				timestamp: hrsAgo(30),
			},
			{
				organization_id: org.id,
				event_type: "invoice.updated",
				action: "updated",
				entity_type: "invoice",
				entity_id: invoice1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					status: { old: "Draft", new: "Sent" },
					_invoice_number: { old: null, new: "INV-0001" },
				},
				timestamp: hrsAgo(24),
			},
			{
				organization_id: org.id,
				event_type: "invoice_payment.created",
				action: "created",
				entity_type: "invoice_payment",
				entity_id: invoice1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					_invoice_number: { old: null, new: "INV-0001" },
					amount: { old: null, new: 525.01 },
					method: { old: null, new: "Check" },
				},
				timestamp: hrsAgo(8),
			},
			{
				organization_id: org.id,
				event_type: "invoice.updated",
				action: "updated",
				entity_type: "invoice",
				entity_id: invoice1.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					status: { old: "Sent", new: "Paid" },
					_invoice_number: { old: null, new: "INV-0001" },
				},
				timestamp: hrsAgo(8),
			},
			{
				organization_id: org.id,
				event_type: "invoice.created",
				action: "created",
				entity_type: "invoice",
				entity_id: invoice4.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					invoice_number: { old: null, new: "INV-0004" },
					total: { old: null, new: 1200.0 },
				},
				timestamp: hrsAgo(336),
			},
			{
				organization_id: org.id,
				event_type: "invoice.updated",
				action: "updated",
				entity_type: "invoice",
				entity_id: invoice4.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					status: { old: "Draft", new: "Sent" },
					_invoice_number: { old: null, new: "INV-0004" },
				},
				timestamp: hrsAgo(335),
			},
			{
				organization_id: org.id,
				event_type: "invoice_payment.created",
				action: "created",
				entity_type: "invoice_payment",
				entity_id: invoice4.id,
				actor_type: "dispatcher",
				actor_id: dispatcher.id,
				actor_name: dispatcher.name,
				changes: {
					_invoice_number: { old: null, new: "INV-0004" },
					amount: { old: null, new: 600.0 },
					method: { old: null, new: "ACH" },
				},
				timestamp: hrsAgo(168),
			},
		],
	});

	// ============================================================================
	// Vehicles
	// Names are tech-independent identifiers (techs switch vehicles freely);
	// assignment is a reassignable many-to-one pointer (technician.current_vehicle_id).
	// ============================================================================

	// All vehicles park at the shop; heading-back routes and return miles need this.
	const shop = { stored_at: org.address, stored_at_coords: { lat: 43.8789, lon: -91.2335 } };

	const van12 = await db.vehicle.create({
		data: {
			...shop,
			organization_id: org.id,
			name: "Van 12",
			type: "Van",
			license_plate: "WIS-4421",
			year: 2021,
			make: "Ford",
			model: "Transit 250",
			status: "active",
			color: "Pearl White",
			notes: "Primary service van. Roof rack with ladder. Currently crewed by John Smith; Kevin Park rode along this week after his usual van went in for service.",
			current_odometer_mi: 41500,
			odometer_updated_at: daysFromNow(-6),
		},
	});

	const van8 = await db.vehicle.create({
		data: {
			...shop,
			organization_id: org.id,
			name: "Van 8",
			type: "Van",
			license_plate: "WIS-8834",
			year: 2019,
			make: "Chevrolet",
			model: "Express 2500",
			status: "active",
			color: "Fleet Blue",
			notes: "Currently crewed by Maria Rodriguez. Check tire pressure weekly.",
			current_odometer_mi: 28750,
			odometer_updated_at: daysFromNow(-9),
		},
	});

	const truck4 = await db.vehicle.create({
		data: {
			...shop,
			organization_id: org.id,
			name: "Truck 4",
			type: "Truck",
			license_plate: "WIS-1109",
			year: 2020,
			make: "Ram",
			model: "ProMaster 2500",
			status: "active",
			color: "Silver",
			notes: "Spare vehicle — unassigned. Fully stocked for overflow and swaps.",
			current_odometer_mi: 52100,
			odometer_updated_at: daysFromNow(-2),
		},
	});

	// Assign current vehicles (techs switch freely; Truck 4 left as an unassigned spare).
	// John Smith and Kevin Park are both on Van 12 right now — vehicles are not 1:1 with techs.
	await Promise.all([
		db.technician.update({ where: { id: tech1.id }, data: { current_vehicle_id: van12.id } }),
		db.technician.update({ where: { id: tech2.id }, data: { current_vehicle_id: van8.id } }),
		db.technician.update({ where: { id: tech3.id }, data: { current_vehicle_id: van12.id } }),
	]);

	// ------------------------------------------------------------------------
	// Pre-create vehicle stock rows (qty_on_hand 0; on-hand is filled by the
	// ledger below). qty_min / qty_standard are set here so recordMovements'
	// upsert path doesn't reset them to 0.
	// ------------------------------------------------------------------------
	const stockManifest: {
		v: { id: string };
		i: { id: string };
		qty_min: number;
		qty_standard: number;
	}[] = [
		// Van 12 (John Smith + Kevin Park)
		{ v: van12, i: invFilter,      qty_min: 4,  qty_standard: 8 },
		{ v: van12, i: invCapacitor,   qty_min: 3,  qty_standard: 6 },
		{ v: van12, i: invContactor,   qty_min: 2,  qty_standard: 3 },
		{ v: van12, i: invThermostat,  qty_min: 2,  qty_standard: 3 },
		{ v: van12, i: invIgniter,     qty_min: 2,  qty_standard: 3 },
		{ v: van12, i: invFlameSensor, qty_min: 3,  qty_standard: 4 },
		{ v: van12, i: invBlower,      qty_min: 1,  qty_standard: 1 },
		// Van 8 (Maria Rodriguez)
		{ v: van8,  i: invRefrigerant, qty_min: 2,  qty_standard: 2 },
		{ v: van8,  i: invFilter,      qty_min: 4,  qty_standard: 10 },
		{ v: van8,  i: invCapacitor,   qty_min: 3,  qty_standard: 4 },
		{ v: van8,  i: invCondPump,    qty_min: 1,  qty_standard: 2 },
		// Truck 4 (spare — fully loaded)
		{ v: truck4, i: invRefrigerant, qty_min: 2,  qty_standard: 4 },
		{ v: truck4, i: invFilter,      qty_min: 8,  qty_standard: 24 },
		{ v: truck4, i: invCapacitor,   qty_min: 4,  qty_standard: 10 },
		{ v: truck4, i: invThermostat,  qty_min: 2,  qty_standard: 4 },
		{ v: truck4, i: invContactor,   qty_min: 2,  qty_standard: 5 },
		{ v: truck4, i: invBlower,      qty_min: 1,  qty_standard: 1 },
		{ v: truck4, i: invIgniter,     qty_min: 2,  qty_standard: 3 },
		{ v: truck4, i: invFlameSensor, qty_min: 2,  qty_standard: 4 },
		{ v: truck4, i: invCondPump,    qty_min: 1,  qty_standard: 2 },
		{ v: truck4, i: invLineSet,     qty_min: 20, qty_standard: 50 },
		{ v: truck4, i: invCompressor,  qty_min: 1,  qty_standard: 2 },
	];

	const stockMap = new Map<string, { id: string }>();
	for (const m of stockManifest) {
		const row = await db.vehicle_stock_item.create({
			data: {
				vehicle_id: m.v.id,
				inventory_item_id: m.i.id,
				qty_on_hand: 0,
				qty_min: m.qty_min,
				qty_standard: m.qty_standard,
			},
		});
		stockMap.set(`${m.v.id}::${m.i.id}`, row);
	}
	const vs = (v: { id: string }, i: { id: string }) =>
		stockMap.get(`${v.id}::${i.id}`)!;

	// ============================================================================
	// Suppliers — two real vendor entities, attached to the intake movements and
	// lots below so cost origin has something to group by.
	//
	// Deliberately only two: the Refrigerant lots keep their free-text "Airgas" /
	// "RefrigCo Supply" suppliers, which is the pre-migration shape. Keeping both
	// forms in the seed is the point — the cost-origin rollup has to handle a
	// named vendor with no id, and an unattributed receipt landing in
	// "Unrecorded", and neither path is exercised if every row is a tidy FK.
	// ============================================================================

	const supplierFerguson = await db.supplier.create({
		data: {
			organization_id: org.id,
			name: "Ferguson",
			name_key: "ferguson",
			account_number: "ACCT-88213",
			contact_name: "Dana Whitfield",
			phone: "(312) 555-0142",
			email: "orders@example-ferguson.test",
			notes: "Counter pickup on the house account. Warranty RMAs go through Dana.",
		},
	});

	const supplierCopeland = await db.supplier.create({
		data: {
			organization_id: org.id,
			name: "Copeland Distribution",
			name_key: "copeland distribution",
			account_number: "CPD-5510",
			contact_name: "Ray Ortega",
			phone: "(312) 555-0177",
			email: "sales@example-copeland.test",
			notes: "Compressor distributor. Freight adds ~3 days on non-stocked models.",
		},
	});

	// ============================================================================
	// Stock Ledger — every quantity change flows through recordMovements so the
	// stock_movement ledger and cached on-hand columns always reconcile.
	// ============================================================================

	const sysActor = { actor_type: "system" as const };
	const dispActor = { actor_type: "dispatcher" as const, actor_id: dispatcher.id };
	const techActor = (id: string) => ({ actor_type: "technician" as const, actor_id: id });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const move = (actor: any, movements: any[], opts: any = {}) =>
		db.$transaction((tx) => recordMovements(tx, org.id, actor, movements, opts));

	// Same as move(), but rewrites created_at afterward so a movement can sit in
	// the past — recordMovements always stamps now() and offers no override.
	//
	// CALLERS MUST STAY IN CHRONOLOGICAL ORDER: recordMovements checks stock
	// sufficiency against live quantities, so insertion order and backdated
	// order have to agree or the charted curve disagrees with actual on-hand.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const moveAt = async (at: Date, actor: any, movements: any[], opts: any = {}) => {
		const res = await move(actor, movements, opts);
		await db.stock_movement.updateMany({
			where: { id: { in: res.movementIds } },
			data: { created_at: at },
		});
		return res;
	};

	// ============================================================================
	// Serial & Batch Tracking Demo Data — Blower Motor (is_serialized) +
	// Refrigerant (is_batch_tracked). Everything still flows through
	// recordMovements; serial_unit/stock_batch rows are a byproduct of the
	// ledger, never written directly (except recalled_at — the one field the
	// real PATCH endpoint owns, set here after the fact to model discovery).
	// ============================================================================

	// -- Blower Motor: 5 serialized units covering every serial_unit_status --
	await move(sysActor, [
		{
			inventory_item_id: invBlower.id,
			qty: 5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "initial",
			note: "Opening warehouse count (serialized).",
			serial: {
				create: ["BLW24-0001", "BLW24-0002", "BLW24-0003", "BLW24-0004", "BLW24-0005"].map(
					(serial_number) => ({ serial_number }),
				),
			},
		},
	]);
	const [bu1, bu2, bu3, bu4] = await db.serial_unit.findMany({
		where: { inventory_item_id: invBlower.id },
		orderBy: { serial_number: "asc" },
	});

	// Restock — 2 units to Truck 4 (one becomes the steady-state spare, one is
	// written off below), 1 unit to Van 12.
	await move(dispActor, [
		{ inventory_item_id: invBlower.id, qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [bu1.id, bu3.id] } },
		{ inventory_item_id: invBlower.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock", serial: { unit_ids: [bu2.id] } },
	]);

	// Consumed — installed during the completed Williams PM visit (sets the
	// client-linked consumption snapshot recall lookups read from).
	await move(techActor(tech1.id), [
		{ inventory_item_id: invBlower.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: van12.id, to_location_type: "consumed", reason: "parts_used", visit_id: recurringVisit1.id, serial: { unit_ids: [bu2.id] }, note: "Blower motor replaced — noisy bearing found during PM." },
	]);

	// Lost — cracked housing found on Truck 4, written off via an adjustment.
	const blowerLossAdjustment = await db.vehicle_stock_adjustment.create({
		data: {
			organization_id: org.id,
			vehicle_id: truck4.id,
			type: "field_loss",
			note: "Blower motor housing cracked in transit — discarded.",
			created_by_id: dispatcher.id,
		},
	});
	await move(dispActor, [
		{ inventory_item_id: invBlower.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "adjustment", reason: "loss", adjustment_id: blowerLossAdjustment.id, serial: { unit_ids: [bu3.id] }, note: "Cracked housing." },
	]);
	await db.vehicle_stock_adjustment_line.create({
		data: {
			adjustment_id: blowerLossAdjustment.id,
			stock_item_id: vs(truck4, invBlower).id,
			qty_before: 2,
			qty_after: 1,
			inventory_impact: -1,
		},
	});

	// Returned — defective unit sent back to the supplier under warranty
	// (never left the warehouse). The 5th unit (BLW24-0005) is left untouched
	// — a clean "just received, in_warehouse" example.
	await move(dispActor, [
		{ inventory_item_id: invBlower.id, qty: 1, from_location_type: "warehouse", to_location_type: "external", reason: "transfer", serial: { unit_ids: [bu4.id] }, note: "Defective unit returned to Ferguson under warranty — RMA #48213." },
	]);

	// -- Refrigerant R-410A: 3 lots (fresh, near-expiry, recalled) --
	const makeLot = (args: {
		inventory_item_id: string;
		batch_number: string;
		// Set BOTH on a lot from a real vendor: supplier_id is what the rollup
		// groups by, `supplier` is the human-readable name older readers show.
		supplier?: string;
		supplier_id?: string;
		expires_at?: Date;
		// Twin of the receive movement's unit_cost — set both, or the lot header
		// and the ledger disagree about what the delivery cost.
		unit_cost?: number;
		note?: string;
	}) => db.$transaction((tx) => getOrCreateBatch(tx, org.id, args));

	const lotFresh = await makeLot({
		inventory_item_id: invRefrigerant.id,
		batch_number: "LOT-24-0512",
		supplier: "Airgas",
		expires_at: daysFromNow(410),
	});
	const lotNearExpiry = await makeLot({
		inventory_item_id: invRefrigerant.id,
		batch_number: "LOT-24-0138",
		supplier: "Airgas",
		expires_at: daysFromNow(18),
		note: "Received short-dated — prioritize for FIFO consumption.",
	});
	const lotRecalled = await makeLot({
		inventory_item_id: invRefrigerant.id,
		batch_number: "LOT-23-0899",
		supplier: "RefrigCo Supply",
		expires_at: daysFromNow(300),
		note: "Manufacturer recall — valve seal defect reported across this production run.",
	});

	await move(sysActor, [
		{ inventory_item_id: invRefrigerant.id, qty: 5, from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count — Lot LOT-24-0512.", batch_allocations: [{ batch_id: lotFresh.id, qty: 5 }] },
		{ inventory_item_id: invRefrigerant.id, qty: 3, from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count — Lot LOT-24-0138.", batch_allocations: [{ batch_id: lotNearExpiry.id, qty: 3 }] },
		{ inventory_item_id: invRefrigerant.id, qty: 4, from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count — Lot LOT-23-0899.", batch_allocations: [{ batch_id: lotRecalled.id, qty: 4 }] },
	]);

	await move(dispActor, [
		{ inventory_item_id: invRefrigerant.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock", batch_allocations: [{ batch_id: lotFresh.id, qty: 1 }] },
		{ inventory_item_id: invRefrigerant.id, qty: 3, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", batch_allocations: [{ batch_id: lotFresh.id, qty: 3 }] },
		{ inventory_item_id: invRefrigerant.id, qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock", batch_allocations: [{ batch_id: lotRecalled.id, qty: 2 }] },
	]);

	// Consumed on job2 before the recall was discovered — traced by the recall report.
	const visit2RefrigerantLine = await db.job_visit_line_item.findFirst({
		where: { visit_id: visit2.id, inventory_item_id: invRefrigerant.id },
		select: { id: true },
	});
	await move(techActor(tech2.id), [
		{ inventory_item_id: invRefrigerant.id, qty: 2, from_location_type: "vehicle", from_vehicle_id: van8.id, to_location_type: "consumed", reason: "parts_used", visit_id: visit2.id, visit_line_item_id: visit2RefrigerantLine?.id ?? undefined, batch_allocations: [{ batch_id: lotRecalled.id, qty: 2 }], note: "R-410A charge during rooftop install." },
	]);

	// Recall discovered after the fact — blocks the 2 remaining warehouse units
	// from any further pick (fresh/near-expiry lots are unaffected).
	await db.stock_batch.update({
		where: { id: lotRecalled.id },
		data: { recalled_at: daysFromNow(-3) },
	});

	// -- Compressor: dual-tracked, carries a full 12-month BACKDATED ledger (3
	// lots, 10 serialized units, 15 movements) so the History tab has real data
	// to chart. Every step runs through moveAt() in chronological order, and
	// lands on the same warehouse 2 / Truck 4 x1 end state as before.

	// stock_batch/serial_unit received_at/consumed_at are stamped now() by the
	// tracking pass — backdate them too, or the Tracking tab's Received column
	// contradicts the History tab's ledger for the same unit.
	const backdateLot = (lotId: string, at: Date) =>
		db.stock_batch.update({
			where: { id: lotId },
			data: { received_at: at, created_at: at },
		});
	const backdateReceived = (serialNumbers: string[], at: Date) =>
		db.serial_unit.updateMany({
			where: { inventory_item_id: invCompressor.id, serial_number: { in: serialNumbers } },
			data: { received_at: at, created_at: at },
		});
	const backdateConsumed = (serialNumbers: string[], at: Date) =>
		db.serial_unit.updateMany({
			where: { inventory_item_id: invCompressor.id, serial_number: { in: serialNumbers } },
			data: { consumed_at: at },
		});
	const cmpUnit = async (serialNumber: string) =>
		(
			await db.serial_unit.findFirstOrThrow({
				where: { inventory_item_id: invCompressor.id, serial_number: serialNumber },
			})
		).id;

	// -- Cost & pricing history -------------------------------------------------
	// The Cost & Pricing chart reads its two CONFIGURED series (set cost, list
	// price) from the audit log, so backdate the item and write the edit history
	// a year of supplier increases would have left.
	//
	// The LAST value of each field must equal the live column (cost 410,
	// unit_price 620), or buildPriceStepSeries draws the tail as untracked drift.
	const at365 = daysFromNow(-365);
	await db.inventory_item.update({
		where: { id: invCompressor.id },
		data: { created_at: at365 },
	});

	const cmpPriceEdit = (
		timestamp: Date,
		changes: Record<string, { old: number | null; new: number }>,
		event: "created" | "updated" = "updated",
	) => ({
		organization_id: org.id,
		event_type: `inventory_item.${event}`,
		action: event,
		entity_type: "inventory_item",
		entity_id: invCompressor.id,
		actor_type: "dispatcher",
		actor_id: dispatcher.id,
		actor_name: dispatcher.name,
		changes,
		timestamp,
	});

	await db.log.createMany({
		data: [
			cmpPriceEdit(
				at365,
				{ cost: { old: null, new: 368.0 }, unit_price: { old: null, new: 560.0 } },
				"created",
			),
			// Copeland raised the ZP31 line; cost follows immediately, price doesn't.
			cmpPriceEdit(daysFromNow(-320), { cost: { old: 368.0, new: 385.0 } }),
			// Customer price catches up two quarters later.
			cmpPriceEdit(daysFromNow(-230), { unit_price: { old: 560.0, new: 590.0 } }),
			// Second supplier increase — the one that visibly squeezes margin.
			cmpPriceEdit(daysFromNow(-150), { cost: { old: 385.0, new: 410.0 } }),
			// Price rise that restores it.
			cmpPriceEdit(daysFromNow(-60), { unit_price: { old: 590.0, new: 620.0 } }),
		],
	});

	// Five historical compressor replacements. getItemUsage only sees consumption
	// linked through visit_line_item -> visit -> job -> client, so two of the
	// consumptions below are deliberately left unlinked (write-off, counter pull)
	// to exercise that exclusion.
	//
	// `charged` is what the customer was actually billed, not list price — the
	// chart's charged series is realized revenue, including a discount (J-0015),
	// a premium (J-0017) and a contract rate (J-0018).
	// TWO SALES ON THE SAME DAY, AT TWO PRICES, TO TWO CLIENTS.
	//
	// This pair is the whole reason the charged series draws a band instead of a
	// single averaged point: one contract-priced replacement for a property
	// manager and one premium emergency job, both billed the same day. Averaged,
	// they read as $602.50 — a figure neither customer paid. Same day rather
	// than "same week" or "same month": the chart buckets by week by default,
	// and a multi-day gap would only *usually* land in one bucket depending on
	// which weekday the seed happens to run on. Same calendar day makes the
	// band deterministic regardless of run date, and different hours (below)
	// keep the two visits from reading as a duplicate.
	const CMP_BAND_DAYS_AGO = 30;

	const compressorJobSpecs = [
		{ jobNumber: "J-0014", daysAgo: 290, startHour: 8, endHour: 15, charged: 560.0, client: client5, coords: { lat: 43.8198, lon: -91.2514 }, clientLabel: "Riverside Apartments", techId: tech1.id },
		{ jobNumber: "J-0015", daysAgo: 260, startHour: 8, endHour: 15, charged: 540.0, client: client3, coords: { lat: 43.7889, lon: -91.2297 }, clientLabel: "Williams Property Management", techId: tech2.id },
		{ jobNumber: "J-0016", daysAgo: 170, startHour: 8, endHour: 15, charged: 590.0, client: client4, coords: { lat: 43.8334, lon: -91.2601 }, clientLabel: "Anderson Office Complex", techId: tech1.id },
		// The band's high end — after-hours emergency, billed at full premium.
		{ jobNumber: "J-0017", daysAgo: CMP_BAND_DAYS_AGO, startHour: 6, endHour: 9, charged: 660.0, client: client2, coords: { lat: 43.8129, lon: -91.2559 }, clientLabel: "Smith Commercial Properties", techId: tech3.id },
		// The band's low end — same day, same part, contract rate.
		{ jobNumber: "J-0018", daysAgo: CMP_BAND_DAYS_AGO, startHour: 12, endHour: 15, charged: 545.0, client: client3, coords: { lat: 43.7889, lon: -91.2297 }, clientLabel: "Williams Property Management", techId: tech2.id },
	];

	// Derived per visit (not fixed) so job totals don't contradict the line items.
	const CMP_LABOR_TOTAL = 660.0;
	const CMP_TAX_RATE = 0.0825;
	const round2 = (n: number) => Math.round(n * 100) / 100;

	const compressorVisits: { visitId: string; lineId: string }[] = [];
	// Keyed by job number so the invoice fixtures further down can attribute
	// themselves to this historical work.
	const compressorWork = new Map<string, { jobId: string; visitId: string }>();
	for (const spec of compressorJobSpecs) {
		const day = daysFromNow(-spec.daysAgo);
		const startHour = spec.startHour;
		const endHour = spec.endHour;
		const subtotal = round2(spec.charged + CMP_LABOR_TOTAL);
		const taxAmount = round2(subtotal * CMP_TAX_RATE);
		const total = round2(subtotal + taxAmount);
		const histJob = await db.job.create({
			data: {
				organization_id: org.id,
				job_number: spec.jobNumber,
				name: `Compressor Replacement — ${spec.clientLabel}`,
				description:
					"Failed 3-ton scroll compressor diagnosed and replaced under service agreement.",
				priority: "High",
				address: spec.client.address,
				coords: spec.coords,
				status: "Completed",
				client_id: spec.client.id,
				subtotal,
				tax_rate: CMP_TAX_RATE,
				tax_amount: taxAmount,
				actual_total: total,
				completed_at: dateAt(day, endHour),
			},
		});
		const histVisit = await db.job_visit.create({
			data: {
				job_id: histJob.id,
				name: "Compressor Replacement",
				description:
					"Recover charge, swap compressor, pull vacuum, recharge and verify superheat.",
				arrival_constraint: "at",
				finish_constraint: "when_done",
				arrival_time: `${String(startHour).padStart(2, "0")}:00`,
				scheduled_start_at: dateAt(day, startHour),
				scheduled_end_at: dateAt(day, endHour),
				actual_start_at: dateAt(day, startHour, 10),
				actual_end_at: dateAt(day, endHour - 1, 45),
				status: "Completed",
				subtotal,
				tax_rate: CMP_TAX_RATE,
				tax_amount: taxAmount,
				total,
				visit_techs: { create: { tech_id: spec.techId } },
				line_items: {
					create: [
						{
							name: "DEMO - Compressor 3-Ton Scroll R410A",
							quantity: 1,
							unit_price: spec.charged,
							total: spec.charged,
							source: "field_addition",
							item_type: "material",
							sort_order: 0,
							inventory_item_id: invCompressor.id,
						},
						{
							name: "Compressor Replacement Labor (4 hrs)",
							quantity: 4,
							unit_price: 165.0,
							total: 660.0,
							source: "field_addition",
							item_type: "labor",
							sort_order: 1,
						},
					],
				},
			},
		});
		const histLine = await db.job_visit_line_item.findFirstOrThrow({
			where: { visit_id: histVisit.id, inventory_item_id: invCompressor.id },
			select: { id: true },
		});
		compressorVisits.push({ visitId: histVisit.id, lineId: histLine.id });
		compressorWork.set(spec.jobNumber, { jobId: histJob.id, visitId: histVisit.id });
	}
	const [cmpVisitA, cmpVisitB, cmpVisitC, cmpVisitD, cmpVisitE] = compressorVisits;

	// -- t-350d: opening receipt, lot LOT-COMP-23-08 (4 units) -> WH 4 --
	// No unit_cost: reason "initial" is an opening count, not a supplier invoice,
	// and getItemPriceHistory only reads `receive`/`supplier_purchase` for paid
	// cost. Pricing it would claim a bill that was never received.
	const at350 = daysFromNow(-350);
	const lotCompressorOpening = await makeLot({
		inventory_item_id: invCompressor.id,
		batch_number: "LOT-COMP-23-08",
		supplier: "Copeland Distribution",
	});
	await backdateLot(lotCompressorOpening.id, at350);
	await moveAt(at350, sysActor, [
		{
			inventory_item_id: invCompressor.id,
			qty: 4,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "initial",
			note: "Opening warehouse count (dual-tracked) — Lot LOT-COMP-23-08.",
			serial: {
				create: ["CMP23-0101", "CMP23-0102", "CMP23-0103", "CMP23-0104"].map(
					(serial_number) => ({ serial_number, batch_id: lotCompressorOpening.id }),
				),
			},
		},
	]);
	await backdateReceived(["CMP23-0101", "CMP23-0102", "CMP23-0103", "CMP23-0104"], at350);

	// -- t-320d: stage 2 units on Truck 4 -> WH 2 / T4 2 --
	const at320 = daysFromNow(-320);
	await moveAt(at320, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [await cmpUnit("CMP23-0101"), await cmpUnit("CMP23-0102")] }, note: "Staged spare compressors on the install truck." },
	]);

	// -- t-290d: consumed on J-0014 (Riverside) -> WH 2 / T4 1 --
	const at290 = daysFromNow(-290);
	await moveAt(at290, techActor(tech1.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "consumed", reason: "parts_used", visit_id: cmpVisitA.visitId, visit_line_item_id: cmpVisitA.lineId, serial: { unit_ids: [await cmpUnit("CMP23-0101")] }, note: "Compressor seized — replaced under service agreement." },
	]);
	await backdateConsumed(["CMP23-0101"], at290);

	// -- t-260d: consumed on J-0015 (Williams) -> WH 2 / T4 0 --
	const at260 = daysFromNow(-260);
	await moveAt(at260, techActor(tech2.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "consumed", reason: "parts_used", visit_id: cmpVisitB.visitId, visit_line_item_id: cmpVisitB.lineId, serial: { unit_ids: [await cmpUnit("CMP23-0102")] }, note: "Shorted windings on the original compressor." },
	]);
	await backdateConsumed(["CMP23-0102"], at260);

	// -- t-230d: re-stage the truck -> WH 1 / T4 1 --
	const at230 = daysFromNow(-230);
	await moveAt(at230, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [await cmpUnit("CMP23-0103")] } },
	]);

	// -- t-200d: replenishment receipt, lot LOT-COMP-24-01 (3 units) -> WH 4 --
	const at200 = daysFromNow(-200);
	// unit_cost is what Copeland actually billed per unit on this PO — 392 against
	// a configured cost of 385 at the time. That gap is the entire point of
	// charting paid cost separately from set cost.
	const lotCompressorMid = await makeLot({
		inventory_item_id: invCompressor.id,
		batch_number: "LOT-COMP-24-01",
		supplier: "Copeland Distribution",
		supplier_id: supplierCopeland.id,
		unit_cost: 392.0,
	});
	await backdateLot(lotCompressorMid.id, at200);
	await moveAt(at200, dispActor, [
		{
			inventory_item_id: invCompressor.id,
			qty: 3,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			unit_cost: 392.0,
			supplier_id: supplierCopeland.id,
			note: "Replenishment PO — Lot LOT-COMP-24-01.",
			serial: {
				create: ["CMP24-0101", "CMP24-0102", "CMP24-0103"].map((serial_number) => ({
					serial_number,
					batch_id: lotCompressorMid.id,
				})),
			},
		},
	]);
	await backdateReceived(["CMP24-0101", "CMP24-0102", "CMP24-0103"], at200);

	// -- t-170d: consumed on J-0016 (Anderson) -> WH 4 / T4 0 --
	const at170 = daysFromNow(-170);
	await moveAt(at170, techActor(tech1.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "consumed", reason: "parts_used", visit_id: cmpVisitC.visitId, visit_line_item_id: cmpVisitC.lineId, serial: { unit_ids: [await cmpUnit("CMP23-0103")] }, note: "Rooftop unit compressor replacement." },
	]);
	await backdateConsumed(["CMP23-0103"], at170);

	// -- t-150d: re-stage the truck -> WH 3 / T4 1 --
	const at150 = daysFromNow(-150);
	await moveAt(at150, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [await cmpUnit("CMP24-0101")] } },
	]);

	// -- t-120d: warehouse write-off (damaged in storage) -> WH 2. No adjustment_id
	// since vehicle_stock_adjustment is vehicle-scoped; "adjustment" still resolves
	// the unit's status to `lost` via LOCATION_STATUS.
	const at120 = daysFromNow(-120);
	await moveAt(at120, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "adjustment", reason: "loss", serial: { unit_ids: [await cmpUnit("CMP23-0104")] }, note: "Suction line crushed by a fallen pallet — scrapped during cycle count." },
	]);

	// -- t-95d: consumed, no job link (warranty swap done off-ticket) -> T4 0 --
	const at95 = daysFromNow(-95);
	await moveAt(at95, techActor(tech2.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "consumed", reason: "parts_used", serial: { unit_ids: [await cmpUnit("CMP24-0101")] }, note: "Goodwill warranty swap — never ticketed." },
	]);
	await backdateConsumed(["CMP24-0101"], at95);

	// -- t-60d: current-lot receipt, LOT-COMP-24-03 (3 units) -> WH 5 --
	const at60 = daysFromNow(-60);
	// Second priced receipt: 415/unit. The running weighted average lands between
	// the two receipts (3 @ 392 then 3 @ 415 = 403.50), which is what the dashed
	// paid-cost line steps to while the receipt markers stay at 392 and 415. The
	// unattributed 1 @ 402 buy at t-45d nudges it again, to 403.29 over 7 units.
	//
	// Bought from Ferguson rather than Copeland this time, which is what gives
	// the step a CAUSE: the item's cost-origin strip shows two vendors at two
	// different average prices instead of one unexplained jump.
	const lotCompressor = await makeLot({
		inventory_item_id: invCompressor.id,
		batch_number: "LOT-COMP-24-03",
		supplier: "Ferguson",
		supplier_id: supplierFerguson.id,
		unit_cost: 415.0,
	});
	await backdateLot(lotCompressor.id, at60);
	await moveAt(at60, dispActor, [
		{
			inventory_item_id: invCompressor.id,
			qty: 3,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			unit_cost: 415.0,
			supplier_id: supplierFerguson.id,
			note: "Replenishment PO — Lot LOT-COMP-24-03 (switched to Ferguson; Copeland was 3 weeks out).",
			serial: {
				create: ["CMP24-0001", "CMP24-0002", "CMP24-0003"].map((serial_number) => ({
					serial_number,
					batch_id: lotCompressor.id,
				})),
			},
		},
	]);
	await backdateReceived(["CMP24-0001", "CMP24-0002", "CMP24-0003"], at60);

	// -- t-58d: stage the truck -> WH 4 / T4 1 --
	const at58 = daysFromNow(-58);
	await moveAt(at58, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [await cmpUnit("CMP24-0002")] } },
	]);

	// -- t-45d: UNATTRIBUTED receipt, 1 unit @ 402 -> WH 5 / T4 1 --
	//
	// An emergency counter buy where nobody wrote down who sold it. Deliberate:
	// it is the third receipt dot on the chart, it lands in the origin strip's
	// "Unrecorded" row, and it makes the coverage footnote read "2 of 3 receipts
	// name a supplier" instead of a tidy 100% that hides the failure mode.
	const at45 = daysFromNow(-45);
	const lotCompressorGap = await makeLot({
		inventory_item_id: invCompressor.id,
		batch_number: "LOT-COMP-24-02",
		unit_cost: 402.0,
		note: "Emergency counter buy — vendor never recorded on the ticket.",
	});
	await backdateLot(lotCompressorGap.id, at45);
	await moveAt(at45, dispActor, [
		{
			inventory_item_id: invCompressor.id,
			qty: 1,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			unit_cost: 402.0,
			note: "Emergency counter buy — vendor never recorded on the ticket.",
			serial: {
				create: [{ serial_number: "CMP24-0004", batch_id: lotCompressorGap.id }],
			},
		},
	]);
	await backdateReceived(["CMP24-0004"], at45);

	// -- t-30d, early morning: consumed on J-0017 (Smith) — the band's HIGH end.
	// Inside the reorder card's fixed 90d window, so the forecast has real
	// demand to work from. -> WH 5 / T4 0 --
	const at30 = daysFromNow(-CMP_BAND_DAYS_AGO);
	await moveAt(at30, techActor(tech3.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "consumed", reason: "parts_used", visit_id: cmpVisitD.visitId, visit_line_item_id: cmpVisitD.lineId, serial: { unit_ids: [await cmpUnit("CMP24-0002")] }, note: "After-hours emergency callout — billed at premium." },
	]);
	await backdateConsumed(["CMP24-0002"], at30);

	// -- t-30d, midday: consumed on J-0018 (Williams) — the band's LOW end,
	// same calendar day as the sale above and $115 cheaper. Pulled from the
	// shop rather than the truck, which is where the emergency unit had been
	// sitting. -> WH 4 / T4 0 --
	const atPairLow = daysFromNow(-CMP_BAND_DAYS_AGO);
	await moveAt(atPairLow, techActor(tech2.id), [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "consumed", reason: "parts_used", visit_id: cmpVisitE.visitId, visit_line_item_id: cmpVisitE.lineId, serial: { unit_ids: [await cmpUnit("CMP24-0004")] }, note: "Contract-rate replacement — picked up from the shop en route." },
	]);
	await backdateConsumed(["CMP24-0004"], atPairLow);

	// -- t-25d: re-stage the truck -> WH 3 / T4 1 --
	const at25 = daysFromNow(-25);
	await moveAt(at25, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock", serial: { unit_ids: [await cmpUnit("CMP24-0001")] } },
	]);

	// -- t-10d: counter sale straight off the shelf, no job -> WH 2 / T4 1.
	const at10 = daysFromNow(-10);
	await moveAt(at10, dispActor, [
		{ inventory_item_id: invCompressor.id, qty: 1, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption", serial: { unit_ids: [await cmpUnit("CMP24-0003")] }, note: "Counter sale to a contractor — cash ticket, no job created." },
	]);
	await backdateConsumed(["CMP24-0003"], at10);

	// (a) Initial receive — external → warehouse. Sized to cover all downstream
	//     outflow while leaving contactor at/below threshold.
	await move(sysActor, [
		{ inventory_item_id: invFilter.id,      qty: 78,  from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invCapacitor.id,   qty: 32,  from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invThermostat.id,  qty: 15,  from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invContactor.id,   qty: 9,   from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invIgniter.id,     qty: 12,  from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invFlameSensor.id, qty: 18,  from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invCondPump.id,    qty: 6,   from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		{ inventory_item_id: invLineSet.id,     qty: 150, from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
		// 12.5 exercises a non-integer on-hand end to end; both sit below threshold
		// so they also appear in low-stock surfaces.
		{ inventory_item_id: invLineSetSmall.id, qty: 12.5, from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count — partial spool." },
		{ inventory_item_id: invTubingMetric.id, qty: 50,   from_location_type: "external", to_location_type: "warehouse", reason: "initial", note: "Opening warehouse count." },
	]);

	// (b) Base restock — warehouse → each vehicle.
	await move(dispActor, [
		// Van 12
		{ inventory_item_id: invFilter.id,      qty: 8, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		{ inventory_item_id: invCapacitor.id,   qty: 6, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		{ inventory_item_id: invContactor.id,   qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		{ inventory_item_id: invThermostat.id,  qty: 3, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		{ inventory_item_id: invIgniter.id,     qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		{ inventory_item_id: invFlameSensor.id, qty: 4, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock" },
		// Van 8
		{ inventory_item_id: invFilter.id,      qty: 10, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock" },
		{ inventory_item_id: invCapacitor.id,   qty: 2,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock" },
		{ inventory_item_id: invCondPump.id,    qty: 1,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock" },
		// Truck 4 (spare — fully loaded)
		{ inventory_item_id: invFilter.id,      qty: 24, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invCapacitor.id,   qty: 10, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invThermostat.id,  qty: 4,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invContactor.id,   qty: 5,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invIgniter.id,     qty: 3,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invFlameSensor.id, qty: 4,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invCondPump.id,    qty: 2,  from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
		{ inventory_item_id: invLineSet.id,     qty: 50, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: truck4.id, reason: "restock" },
	]);

	// (c) Historical parts_used — vehicle → consumed, tied to completed visits.
	const v1CapLine = await db.job_visit_line_item.findFirst({
		where: { visit_id: visit1.id, inventory_item_id: invCapacitor.id },
		select: { id: true },
	});
	const rv1FilterLine = await db.job_visit_line_item.findFirst({
		where: { visit_id: recurringVisit1.id, inventory_item_id: invFilter.id },
		select: { id: true },
	});

	// visit1: Maria (Van 8) installed 1 capacitor
	await move(techActor(tech2.id), [
		{ inventory_item_id: invCapacitor.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: van8.id, to_location_type: "consumed", reason: "parts_used", visit_id: visit1.id, visit_line_item_id: v1CapLine?.id ?? undefined, note: "Dual run capacitor installed on AC repair." },
	]);
	await db.vehicle_stock_usage.create({
		data: {
			stock_item_id: vs(van8, invCapacitor).id,
			visit_id: visit1.id,
			technician_id: tech2.id,
			qty_used: 1,
			visit_line_item_id: v1CapLine?.id ?? null,
		},
	});

	// recurringVisit1: John (Van 12) used 4 filters on the Williams PM
	await move(techActor(tech1.id), [
		{ inventory_item_id: invFilter.id, qty: 4, from_location_type: "vehicle", from_vehicle_id: van12.id, to_location_type: "consumed", reason: "parts_used", visit_id: recurringVisit1.id, visit_line_item_id: rv1FilterLine?.id ?? undefined, note: "Filter replacement across 4 units." },
	]);
	await db.vehicle_stock_usage.create({
		data: {
			stock_item_id: vs(van12, invFilter).id,
			visit_id: recurringVisit1.id,
			technician_id: tech1.id,
			qty_used: 4,
			visit_line_item_id: rv1FilterLine?.id ?? null,
		},
	});

	// (d) Direct consumption — warehouse → consumed (dispatch-allocated part).
	await move(dispActor, [
		{ inventory_item_id: invIgniter.id, qty: 1, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption", note: "Igniter pulled from warehouse for counter sale / shop use." },
	]);

	// (e) Transfer — Truck 4 → Van 8 (top up Maria's capacitors from the spare).
	await move(dispActor, [
		{ inventory_item_id: invCapacitor.id, qty: 2, from_location_type: "vehicle", from_vehicle_id: truck4.id, to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "transfer", note: "Capacitors moved from spare truck to Van 8." },
	]);

	// (f) Loss — damaged refrigerant cylinder on Van 8, recorded against a field_loss adjustment.
	const lossAdjustment = await db.vehicle_stock_adjustment.create({
		data: {
			organization_id: org.id,
			vehicle_id: van8.id,
			type: "field_loss",
			note: "Refrigerant cylinder valve damaged in transit — discarded.",
			created_by_tech_id: tech2.id,
		},
	});
	await move(techActor(tech2.id), [
		{ inventory_item_id: invRefrigerant.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: van8.id, to_location_type: "adjustment", reason: "loss", adjustment_id: lossAdjustment.id, batch_allocations: [{ batch_id: lotFresh.id, qty: 1 }], note: "Damaged R-410A cylinder." },
	]);
	await db.vehicle_stock_adjustment_line.create({
		data: {
			adjustment_id: lossAdjustment.id,
			stock_item_id: vs(van8, invRefrigerant).id,
			qty_before: 1,
			qty_after: 0,
			inventory_impact: -1,
		},
	});

	// (g) Supplier purchase — Maria/John bought flame sensors at a local supply
	// house (external → Van 12). Priced and attributed, so the field-purchase
	// path contributes to cost origin the same way a warehouse receipt does.
	await move(techActor(tech1.id), [
		{ inventory_item_id: invFlameSensor.id, qty: 2, from_location_type: "external", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "supplier_purchase", unit_cost: 21.5, supplier_id: supplierFerguson.id, note: "Field purchase — 2 flame sensors from Ferguson." },
	]);

	// ============================================================================
	// Vendor price list — the catalog the reorder forecast reads to answer
	// "buy 8 from whom, at what?".
	//
	// The rows below ALREADY EXIST by this point: recordMovements writes
	// last_price/last_purchased_at for every attributed, priced intake above.
	// What it can't know is the negotiated side — part numbers, contract rates,
	// lead times, and which vendor is the preferred one — so that's what gets
	// filled in here. upsert, not update, so this stands on its own if the
	// movements above ever change.
	// ============================================================================

	const priceListRow = (args: {
		supplier_id: string;
		inventory_item_id: string;
		vendor_sku: string;
		contract_price?: number;
		lead_time_days?: number;
		min_order_qty?: number;
		is_preferred?: boolean;
		notes?: string;
	}) =>
		db.supplier_item.upsert({
			where: {
				supplier_id_inventory_item_id: {
					supplier_id: args.supplier_id,
					inventory_item_id: args.inventory_item_id,
				},
			},
			create: { organization_id: org.id, ...args },
			update: args,
		});

	// Compressor, both vendors — the two-vendor split the cost-origin strip shows.
	// Ferguson is preferred despite the higher last price: they had it on the
	// shelf, and the forecast reports a contract rate that beats both receipts.
	await priceListRow({
		supplier_id: supplierFerguson.id,
		inventory_item_id: invCompressor.id,
		vendor_sku: "FRG-CMP-4T",
		contract_price: 405.0,
		lead_time_days: 2,
		is_preferred: true,
		notes: "Stocked locally — same-day counter pickup on the house account.",
	});
	await priceListRow({
		supplier_id: supplierCopeland.id,
		inventory_item_id: invCompressor.id,
		vendor_sku: "CPD-ZR34K3",
		lead_time_days: 9,
		min_order_qty: 2,
		notes: "Cheaper per unit, but 9-day freight and a 2-unit minimum.",
	});

	// Flame sensor — one vendor, observed price only. No contract rate, so the
	// forecast prices this off what was actually paid and labels it as such.
	await priceListRow({
		supplier_id: supplierFerguson.id,
		inventory_item_id: invFlameSensor.id,
		vendor_sku: "FRG-FS-118",
		lead_time_days: 1,
		is_preferred: true,
	});

	// Igniter — the inverse case: a negotiated rate on an item we have never
	// recorded a purchase for, so contract_price is the ONLY price available.
	await priceListRow({
		supplier_id: supplierFerguson.id,
		inventory_item_id: invIgniter.id,
		vendor_sku: "FRG-IGN-770",
		contract_price: 18.75,
		lead_time_days: 1,
		min_order_qty: 5,
		is_preferred: true,
		notes: "Annual pricing agreement — held through year end.",
	});

	// ============================================================================
	// Restock Requests — all four lifecycle states (each on a distinct stock item)
	// ============================================================================

	// pending — John flags low igniters on Van 12
	await db.vehicle_restock_request.create({
		data: {
			organization_id: org.id,
			stock_item_id: vs(van12, invIgniter).id,
			technician_id: tech1.id,
			qty_requested: 2,
			note: "Down to a couple igniters — please top up.",
			status: "pending",
		},
	});

	// dismissed — Maria's condensate pump request, declined by dispatch
	await db.vehicle_restock_request.create({
		data: {
			organization_id: org.id,
			stock_item_id: vs(van8, invCondPump).id,
			technician_id: tech2.id,
			qty_requested: 1,
			note: "Would like a spare condensate pump.",
			status: "dismissed",
			dismissed_reason: "dispatch",
		},
	});

	// acknowledged — Maria's capacitor request, dispatch has seen it
	await db.vehicle_restock_request.create({
		data: {
			organization_id: org.id,
			stock_item_id: vs(van8, invCapacitor).id,
			technician_id: tech2.id,
			qty_requested: 2,
			note: "Restock capacitors after the AC repair.",
			status: "acknowledged",
			acknowledged_at: daysFromNow(-1),
			acknowledged_by_id: dispatcher.id,
		},
	});

	// resolved — John's thermostat request, auto-resolved by a warehouse restock
	await db.vehicle_restock_request.create({
		data: {
			organization_id: org.id,
			stock_item_id: vs(van12, invThermostat).id,
			technician_id: tech1.id,
			qty_requested: 2,
			note: "Need two thermostats for upcoming installs.",
			status: "resolved",
			resolved_at: daysFromNow(-1),
			resolved_note: "Auto-resolved by stock movement (dispatcher)",
		},
	});
	await move(dispActor, [
		{ inventory_item_id: invThermostat.id, qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock", note: "Restocked thermostats for tomorrow's installs." },
	]);

	// ============================================================================
	// End-of-Day records + readiness
	// ============================================================================

	// EOD #1 — Van 12, John, yesterday. Contactor restock fell short (warehouse low).
	const restock1 = await db.vehicle_restock_record.create({
		data: {
			organization_id: org.id,
			vehicle_id: van12.id,
			completed_at: yesterday,
			day: yesterday,
			completed_by_tech_id: tech1.id,
			notes: "Restocked filters from warehouse. Contactors short — flagged for reorder.",
		},
	});
	await move(techActor(tech1.id), [
		{ inventory_item_id: invFilter.id,    qty: 4, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock", restock_record_id: restock1.id, note: "EOD restock." },
		{ inventory_item_id: invContactor.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van12.id, reason: "restock", restock_record_id: restock1.id, note: "EOD restock (partial — warehouse low)." },
	]);
	await db.vehicle_restock_line.createMany({
		data: [
			{ restock_record_id: restock1.id, stock_item_id: vs(van12, invFilter).id,    qty_restocked: 4, qty_shortfall: 0 },
			{ restock_record_id: restock1.id, stock_item_id: vs(van12, invContactor).id, qty_restocked: 1, qty_shortfall: 2 },
		],
	});

	// EOD #2 — Van 8, Maria, today. Zero shortfall → auto-confirms readiness for tomorrow.
	const restock2 = await db.vehicle_restock_record.create({
		data: {
			organization_id: org.id,
			vehicle_id: van8.id,
			completed_at: today,
			day: today,
			completed_by_tech_id: tech2.id,
			notes: "Full restock from warehouse. Ready for tomorrow.",
		},
	});
	await move(techActor(tech2.id), [
		{ inventory_item_id: invRefrigerant.id, qty: 1, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock", restock_record_id: restock2.id, note: "EOD restock." },
		{ inventory_item_id: invFilter.id,      qty: 2, from_location_type: "warehouse", to_location_type: "vehicle", to_vehicle_id: van8.id, reason: "restock", restock_record_id: restock2.id, note: "EOD restock." },
	]);
	await db.vehicle_restock_line.createMany({
		data: [
			{ restock_record_id: restock2.id, stock_item_id: vs(van8, invRefrigerant).id, qty_restocked: 1, qty_shortfall: 0 },
			{ restock_record_id: restock2.id, stock_item_id: vs(van8, invFilter).id,      qty_restocked: 2, qty_shortfall: 0 },
		],
	});
	await db.vehicle_readiness.create({
		data: {
			vehicle_id: van8.id,
			organization_id: org.id,
			date: today,
			confirmed_by_tech_id: tech2.id,
			restock_record_id: restock2.id,
			notes: "Auto-confirmed at EOD — zero shortfalls.",
		},
	});

	// ============================================================================
	// Stock Adjustment — audit correction (cycle count found Van 12 short 1 igniter)
	// ============================================================================
	const auditAdjustment = await db.vehicle_stock_adjustment.create({
		data: {
			organization_id: org.id,
			vehicle_id: van12.id,
			type: "audit",
			note: "Cycle count: 1 igniter unaccounted for on Van 12.",
			created_by_id: dispatcher.id,
		},
	});
	await move(dispActor, [
		{ inventory_item_id: invIgniter.id, qty: 1, from_location_type: "vehicle", from_vehicle_id: van12.id, to_location_type: "adjustment", reason: "audit_correction", adjustment_id: auditAdjustment.id, note: "Audit write-down." },
	]);
	await db.vehicle_stock_adjustment_line.create({
		data: {
			adjustment_id: auditAdjustment.id,
			stock_item_id: vs(van12, invIgniter).id,
			qty_before: 2,
			qty_after: 1,
			inventory_impact: -1,
		},
	});

	// ============================================================================
	// Shifts + Time Entries
	// ============================================================================
	const [shift1, shift2] = await Promise.all([
		db.technician_shift.create({
			data: {
				tech_id: tech1.id,
				org_id: org.id,
				started_at: dateAt(yesterday, 7),
				ended_at: dateAt(yesterday, 16, 30),
				gross_hours: 9.5,
				break_hours: 0.5,
				payable_hours: 9.0,
			},
		}),
		db.technician_shift.create({
			data: {
				tech_id: tech2.id,
				org_id: org.id,
				started_at: dateAt(yesterday, 8),
				ended_at: dateAt(yesterday, 16),
				gross_hours: 8.0,
				break_hours: 0.5,
				payable_hours: 7.5,
			},
		}),
	]);
	await db.technician_shift_break.createMany({
		data: [
			{ shift_id: shift1.id, tech_id: tech1.id, reason: "Lunch", is_paid: false, pre_break_status: "Working", started_at: dateAt(yesterday, 12), ended_at: dateAt(yesterday, 12, 30), duration_hrs: 0.5 },
			{ shift_id: shift2.id, tech_id: tech2.id, reason: "Lunch", is_paid: false, pre_break_status: "Working", started_at: dateAt(yesterday, 12, 30), ended_at: dateAt(yesterday, 13), duration_hrs: 0.5 },
		],
	});
	await db.visit_tech_time_entry.createMany({
		data: [
			{ visit_id: visit1.id, tech_id: tech2.id, clocked_in_at: dateAt(yesterday, 9, 15), clocked_out_at: dateAt(yesterday, 11, 30), hours_worked: 2.25 },
			{ visit_id: recurringVisit1.id, tech_id: tech1.id, clocked_in_at: dateAt(occurrencePastStart, 8, 5), clocked_out_at: dateAt(occurrencePastStart, 11, 50), hours_worked: 3.75 },
		],
	});
	await db.technician_shift.createMany({
		data: [
			{ tech_id: tech1.id, org_id: org.id, started_at: dateAt(today, 7), ended_at: null},
			{ tech_id: tech2.id, org_id: org.id, started_at: dateAt(today, 8), ended_at: null},
		],
	})

	// ============================================================================
	// Technician Notifications (John Smith)
	// ============================================================================
	await db.technician_notification.createMany({
		data: [
			{ technician_id: tech1.id, type: "visit_assigned", title: "New visit assigned", body: "You've been assigned to Filter Replacement — Anderson Bldg A today at 8:00 AM.", action_url: `/technician/visits/${todayFilterVisit.id}`, created_at: minsAgo(45) },
			{ technician_id: tech1.id, type: "visit_changed", title: "Visit time updated", body: "Follow-Up AC Check — Johnson Residence moved to the 11:00–12:00 window.", action_url: `/technician/visits/${todayFollowUpVisit.id}`, read_at: minsAgo(20), created_at: hrsAgo(3) },
			{ technician_id: tech1.id, type: "dispatch_message", title: "Message from dispatch", body: "Heads up — Kevin is riding with you on Van 12 this week. Coordinate the morning route.", created_at: hrsAgo(20) },
		],
	});

	// ============================================================================
	// Inventory Tags
	// ============================================================================
	await Promise.all([
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: "Fast-moving",
				items: { connect: [{ id: invFilter.id }, { id: invCapacitor.id }, { id: invMaxLenStress.id }] },
			},
		}),
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: "Electrical",
				items: { connect: [{ id: invCapacitor.id }, { id: invContactor.id }, { id: invMaxLenStress.id }] },
			},
		}),
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: "Refrigerant",
				items: { connect: [{ id: invRefrigerant.id }, { id: invLineSet.id }, { id: invMaxLenStress.id }] },
			},
		}),
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: "Controls",
				items: { connect: [{ id: invThermostat.id }, { id: invIgniter.id }, { id: invFlameSensor.id }, { id: invMaxLenStress.id }] },
			},
		}),
		// Two tags at the 100-char label cap, both on the stress item, so it
		// carries six chips including two full-width ones.
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: padTo("MAXLEN TAG — Warranty Claim Documentation Required Before Return", 100),
				items: { connect: [{ id: invMaxLenStress.id }] },
			},
		}),
		db.inventory_tag.create({
			data: {
				organization_id: org.id,
				label: padTo("MAXLEN TAG — Special Order Long Lead Time Vendor Drop-Ship", 100),
				items: { connect: [{ id: invMaxLenStress.id }] },
			},
		}),
	]);

	// ============================================================================
	// Unknown Parts Reconcile — provisional catalog items
	// The reconcile queue has two halves: unmapped line NAMES (below) and
	// provisional ITEMS somebody created on the fly. These three cover every
	// origin a dispatcher can filter by except `import`.
	// ============================================================================

	const [provCondFanMotor, provCurbAdapter, provDuctSealant] = await Promise.all([
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Condenser Fan Motor 1/6 HP (unbranded)",
				description:
					"Submitted from the field after a counter purchase — brand and model plate unreadable.",
				location: "Van 8 — unshelved",
				quantity: 0,
				unit_price: 155.0,
				cost: 78.0,
				category: "Motors",
				unit: "each",
				provisional: true,
				origin: "tech_submission",
				created_by_tech_id: tech2.id,
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Custom Roof Curb Adapter — 5 Ton",
				description: "Quick-added off a quote line. Fabricated per job; may never be stocked.",
				location: "Fabrication — staged",
				quantity: 0,
				unit_price: 620.0,
				cost: 340.0,
				category: "Sheet Metal",
				unit: "each",
				provisional: true,
				origin: "dispatch_quick_add",
			},
		}),
		db.inventory_item.create({
			data: {
				organization_id: org.id,
				name: "Duct Sealant Mastic (1 gal)",
				description: "Created off an approved field purchase receipt line.",
				location: "Van 12 — bin 3",
				quantity: 0,
				unit_price: 44.0,
				cost: 24.5,
				low_stock_threshold: 2,
				category: "Consumables",
				unit: "each",
				provisional: true,
				origin: "field_purchase",
				created_by_tech_id: tech1.id,
			},
		}),
	]);

	// ============================================================================
	// Line item ↔ inventory lifecycle — what the linkage backfill leaves behind
	// ============================================================================

	// `used` is decided by the LEDGER, not by visit status: a line with a
	// parts_used movement already left the warehouse, and deductInventoryForVisit
	// skips only `used`, so anything else here would arm those rows to consume the
	// same stock twice on re-completion.
	const consumedLineIds = (
		await db.stock_movement.findMany({
			where: { organization_id: org.id, reason: "parts_used", visit_line_item_id: { not: null } },
			select: { visit_line_item_id: true },
			distinct: ["visit_line_item_id"],
		})
	).map((m) => m.visit_line_item_id!);

	await db.job_visit_line_item.updateMany({
		where: { id: { in: consumedLineIds } },
		data: { fulfillment_status: "used", disposition: "consume" },
	});
	await db.job_visit_line_item.updateMany({
		where: {
			visit: { job: { organization_id: org.id } },
			inventory_item_id: { not: null },
			fulfillment_status: null,
		},
		data: { fulfillment_status: "planned", disposition: "consume" },
	});
	// Same rule the migration applied: a linked plan line always deducted stock.
	await db.recurring_plan_line_item.updateMany({
		where: { recurring_plan: { organization_id: org.id }, inventory_item_id: { not: null } },
		data: { disposition: "consume" },
	});

	// Reconciled with variance: dispatch planned 6 filters, the tech used 4. The
	// billed quantity is the truth; qty_planned is what the variance reads from.
	if (rv1FilterLine) {
		await db.job_visit_line_item.update({
			where: { id: rv1FilterLine.id },
			data: {
				qty_planned: 6,
				reconciled_at: dateAt(occurrencePastStart, 11, 45),
				reconciled_by_tech_id: tech1.id,
			},
		});
	}
	if (v1CapLine) {
		await db.job_visit_line_item.update({
			where: { id: v1CapLine.id },
			data: { qty_planned: 1, reconciled_at: daysFromNow(-2), reconciled_by_tech_id: tech1.id },
		});
	}

	// Voided: tech opened the panel and the part was fine. Billing zeroed,
	// qty_planned kept so the variance report still shows what was carried.
	await db.job_visit_line_item.create({
		data: {
			visit_id: visit8.id,
			name: "Capacitor 45+5 MFD 440V Round",
			description: "Carried for the coil call — existing capacitor tested in spec, not replaced.",
			quantity: 0,
			unit_price: 22.0,
			total: 0,
			source: "field_addition",
			item_type: "material",
			inventory_item_id: invCapacitor.id,
			fulfillment_status: "voided",
			qty_planned: 2,
			disposition: "consume",
			reconciled_at: hrsAgo(1),
			reconciled_by_tech_id: tech1.id,
			sort_order: 9,
		},
	});

	// Dispositions: all three on one scheduled visit, so the picker's whole
	// vocabulary is reachable from a single screen.
	await db.job_visit_line_item.createMany({
		data: [
			{
				visit_id: visit3.id,
				name: "Air Filter 16x25x1 MERV-8",
				description: "Pulled from warehouse stock for the PM.",
				quantity: 6,
				unit_price: 8.5,
				total: 51.0,
				source: "manual",
				item_type: "material",
				inventory_item_id: invFilter.id,
				fulfillment_status: "planned",
				qty_planned: 6,
				disposition: "consume",
				sort_order: 3,
			},
			{
				visit_id: visit3.id,
				name: "Contactor 2-Pole 40A 24V (counter pickup, 5-pack)",
				description:
					"Bought at the counter for this PM and billed to it; the pack lands on Van 12 and is drawn down from there.",
				quantity: 5,
				unit_price: 28.0,
				total: 140.0,
				source: "manual",
				item_type: "material",
				inventory_item_id: invContactor.id,
				fulfillment_status: "planned",
				qty_planned: 5,
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: van12.id,
				sort_order: 4,
			},
			{
				visit_id: visit3.id,
				name: "Condensate Pump — vendor drop-ship to site",
				description: "Shipped straight to the roof by the supplier. Billed, never in our stock.",
				quantity: 1,
				unit_price: 95.0,
				total: 95.0,
				source: "manual",
				item_type: "material",
				inventory_item_id: invCondPump.id,
				fulfillment_status: "planned",
				qty_planned: 1,
				disposition: "non_stock",
				sort_order: 5,
			},
		],
	});

	// A plan line that must never deduct: the supplier ships it per occurrence.
	await db.recurring_plan_line_item.create({
		data: {
			recurring_plan_id: recurringPlan2.id,
			name: "Hot Surface Igniter (Universal) — supplier drop-ship",
			description: "Standing drop-ship on the Anderson contract; never passes through our shelves.",
			quantity: 1,
			unit_price: 42.0,
			item_type: "material",
			inventory_item_id: invIgniter.id,
			disposition: "non_stock",
			sort_order: 8,
		},
	});

	// ============================================================================
	// Reconcile backlog — one unmapped name per match tier the audit can return,
	// so every branch of the queue's suggestion column has a row to render.
	// ============================================================================

	await db.quote_line_item.createMany({
		data: [
			// tier: exact — name is byte-identical to the catalog item.
			{
				quote_id: quote2.id,
				name: "Air Filter 16x25x1 MERV-8",
				quantity: 12,
				unit_price: 8.5,
				total: 102.0,
				item_type: "material",
				sort_order: 6,
			},
			// tier: none — fabricated, and it recurs across three entities below.
			{
				quote_id: quote2.id,
				name: "Sheet Metal Transition Duct (fabricated)",
				quantity: 1,
				unit_price: 240.0,
				total: 240.0,
				item_type: "material",
				sort_order: 7,
			},
		],
	});

	await db.job_line_item.createMany({
		data: [
			// tier: case_insensitive
			{
				job_id: job3.id,
				name: "capacitor 45+5 mfd 440v round",
				quantity: 3,
				unit_price: 22.0,
				total: 66.0,
				source: "manual",
				item_type: "material",
			},
			{
				job_id: job2.id,
				name: "Sheet Metal Transition Duct (fabricated)",
				quantity: 2,
				unit_price: 240.0,
				total: 480.0,
				source: "manual",
				item_type: "material",
			},
			// tier: none, highest single value — the row the queue opens on.
			{
				job_id: job2.id,
				name: "Rooftop Curb Adapter — 5 Ton",
				quantity: 1,
				unit_price: 620.0,
				total: 620.0,
				source: "manual",
				item_type: "equipment",
			},
			// Dismissed below: a refundable core deposit is not a catalog part.
			{
				job_id: job2.id,
				name: "Core Charge — Compressor",
				quantity: 1,
				unit_price: 85.0,
				total: 85.0,
				source: "manual",
				item_type: "material",
			},
		],
	});

	await db.job_visit_line_item.create({
		data: {
			visit_id: visit3.id,
			name: "Sheet Metal Transition Duct (fabricated)",
			quantity: 1,
			unit_price: 240.0,
			total: 240.0,
			source: "manual",
			item_type: "material",
			sort_order: 6,
		},
	});

	// tier: code — matches the capacitor's alt_id rather than its name.
	await db.recurring_plan_line_item.create({
		data: {
			recurring_plan_id: recurringPlan2.id,
			name: "97F9895",
			quantity: 2,
			unit_price: 22.0,
			item_type: "material",
			sort_order: 9,
		},
	});

	// Billing lines pointing AT the provisional items, so the queue's provisional
	// half ranks by money the same way its unmapped half does — a provisional item
	// nothing bills against is a different (and smaller) problem.
	await Promise.all([
		db.job_visit_line_item.create({
			data: {
				visit_id: visit3.id,
				name: "Duct Sealant Mastic (1 gal)",
				quantity: 1,
				unit_price: 44.0,
				total: 44.0,
				source: "manual",
				item_type: "material",
				inventory_item_id: provDuctSealant.id,
				fulfillment_status: "planned",
				qty_planned: 1,
				disposition: "consume",
				sort_order: 7,
			},
		}),
		db.job_line_item.create({
			data: {
				job_id: job5.id,
				name: "Condenser Fan Motor 1/6 HP (unbranded)",
				quantity: 1,
				unit_price: 155.0,
				total: 155.0,
				source: "field_addition",
				item_type: "material",
				inventory_item_id: provCondFanMotor.id,
			},
		}),
		db.quote_line_item.create({
			data: {
				quote_id: quote1.id,
				name: "Custom Roof Curb Adapter — 5 Ton",
				quantity: 1,
				unit_price: 620.0,
				total: 620.0,
				item_type: "equipment",
				inventory_item_id: provCurbAdapter.id,
				sort_order: 8,
			},
		}),
	]);

	// Terminal decision, not a gap: dismissal drops the name out of the queue AND
	// out of the coverage denominator, which is what keeps coverage reachable.
	await db.unmapped_part_decision.create({
		data: {
			organization_id: org.id,
			folded_name: "core charge — compressor",
			decided_by_id: dispatcher.id,
			decided_at: hrsAgo(30),
			reason: "Refundable deposit, not a part. Never belongs on the catalog.",
		},
	});

	// ============================================================================
	// Field Purchase Grants — authority is per technician and revocable, so the
	// seed carries an active senior grant, a tight junior one, and a revoked row.
	// ============================================================================

	const grantSmith = await db.field_purchase_grant.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			per_transaction_limit: 750.0,
			daily_limit: 1200.0,
			weekly_limit: 3000.0,
			per_job_limit: 1500.0,
			is_active: true,
			granted_by_id: dispatcher.id,
			granted_at: daysFromNow(-45),
			notes: "Senior tech, on-call rotation. Raised from 400 after the March rooftop season.",
		},
	});

	const grantRodriguez = await db.field_purchase_grant.create({
		data: {
			organization_id: org.id,
			technician_id: tech2.id,
			per_transaction_limit: 200.0,
			daily_limit: 400.0,
			weekly_limit: 900.0,
			is_active: true,
			granted_by_id: dispatcher.id,
			granted_at: daysFromNow(-30),
			notes: "Residential routes only. Anything larger goes through dispatch.",
		},
	});

	// Revoked, never deleted — a purchase already in flight still has to reconcile.
	const grantPark = await db.field_purchase_grant.create({
		data: {
			organization_id: org.id,
			technician_id: tech3.id,
			per_transaction_limit: 150.0,
			daily_limit: 300.0,
			is_active: false,
			granted_by_id: dispatcher.id,
			granted_at: daysFromNow(-60),
			revoked_by_id: dispatcher.id,
			revoked_at: daysFromNow(-12),
			notes: "Revoked pending receipt training — reinstate after the next ride-along.",
		},
	});

	await db.field_purchase_event.createMany({
		data: [
			{ organization_id: org.id, grant_id: grantSmith.id, type: "grant.granted", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { per_transaction_limit: "400.00" }, at: daysFromNow(-90) },
			{ organization_id: org.id, grant_id: grantSmith.id, type: "grant.updated", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { per_transaction_limit: { from: "400.00", to: "750.00" } }, at: daysFromNow(-45) },
			{ organization_id: org.id, grant_id: grantRodriguez.id, type: "grant.granted", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { per_transaction_limit: "200.00" }, at: daysFromNow(-30) },
			{ organization_id: org.id, grant_id: grantPark.id, type: "grant.granted", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { per_transaction_limit: "150.00" }, at: daysFromNow(-60) },
			{ organization_id: org.id, grant_id: grantPark.id, type: "grant.revoked", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { reason: "Receipt training outstanding" }, at: daysFromNow(-12) },
		],
	});

	// ============================================================================
	// Field Purchases — one row per status the review queue can show, all on John
	// Smith except the last, so a dispatcher's queue is not single-technician.
	// ============================================================================

	// Receipts render through a bare <img src>, and an object-storage URL from a
	// seeded row points at nothing. An inline SVG is a real image the browser can
	// draw, so the review panel shows evidence instead of a broken-image icon.
	// Keep the text ampersand-free: this string is parsed as XML.
	const receiptImage = (
		vendor: string,
		when: string,
		total: string,
		lines: [string, string][],
	): string => {
		const h = 150 + lines.length * 22;
		const rule = 86 + lines.length * 22;
		const body = lines
			.map(
				([desc, amt], i) =>
					`<text x="20" y="${90 + i * 22}" font-family="monospace" font-size="11" fill="#222">${desc}</text>` +
					`<text x="300" y="${90 + i * 22}" font-family="monospace" font-size="11" text-anchor="end" fill="#222">${amt}</text>`,
			)
			.join("");
		return (
			"data:image/svg+xml;utf8," +
			encodeURIComponent(
				`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${h}" viewBox="0 0 320 ${h}">` +
					`<rect width="100%" height="100%" fill="#fdfcf7"/>` +
					`<text x="160" y="34" font-family="monospace" font-size="16" text-anchor="middle" fill="#111">${vendor}</text>` +
					`<text x="160" y="54" font-family="monospace" font-size="11" text-anchor="middle" fill="#555">${when}</text>` +
					`<line x1="20" y1="68" x2="300" y2="68" stroke="#bbb"/>` +
					body +
					`<line x1="20" y1="${rule}" x2="300" y2="${rule}" stroke="#bbb"/>` +
					`<text x="20" y="${rule + 24}" font-family="monospace" font-size="13" fill="#111">TOTAL</text>` +
					`<text x="300" y="${rule + 24}" font-family="monospace" font-size="13" text-anchor="end" fill="#111">${total}</text>` +
					`</svg>`,
			)
		);
	};

	const receiptHash = (url: string) => crypto.createHash("sha256").update(url).digest("hex");

	interface SeedPurchaseLine {
		description: string;
		quantity: number;
		unit_price: number;
		inventory_item_id?: string;
		disposition?: "receive" | "non_stock";
		disposition_location?: "warehouse" | "vehicle";
		disposition_vehicle_id?: string;
		ocr_confidence?: number;
		/** Verification is per line and mandatory before submit. */
		unverified?: boolean;
	}

	const purchaseLines = (lines: SeedPurchaseLine[], verifiedAt: Date | null) =>
		lines.map((l, i) => ({
			description: l.description,
			quantity: l.quantity,
			unit_price: l.unit_price,
			line_total: Number((l.quantity * l.unit_price).toFixed(2)),
			inventory_item_id: l.inventory_item_id ?? null,
			disposition: l.disposition ?? null,
			disposition_location: l.disposition_location ?? null,
			disposition_vehicle_id: l.disposition_vehicle_id ?? null,
			ocr_confidence: l.ocr_confidence ?? null,
			verified_at: l.unverified ? null : verifiedAt,
			sort_order: i,
		}));

	// What OCR returned, kept so the tech's corrections stay diffable at submit.
	const ocrSnapshot = (lines: SeedPurchaseLine[]) =>
		lines.map((l) => ({
			description: l.description,
			quantity: l.quantity,
			unit_price: l.unit_price,
			line_total: Number((l.quantity * l.unit_price).toFixed(2)),
		}));

	const GEO_MISSING = {
		code: "geo_missing",
		message: "No capture location recorded (expected on desktop, advisory only)",
	};

	// 1. draft — started at the counter, nothing captured yet.
	const fpDraft = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "draft",
			reason: "Belt shredded on the Anderson rooftop — grabbing a replacement.",
			estimated_amount: 85.0,
			created_at: minsAgo(25),
			allocations: { create: [{ job_id: job3.id, job_visit_id: visit3.id, amount: 85.0 }] },
		},
	});

	// 2. pending_preauth — the estimate is over John's 750 per-transaction ceiling,
	// so the flow routed to dispatch instead of refusing him at the counter.
	const fpPreauthPending = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "pending_preauth",
			reason: "Compressor is seized on the Smith Bldg 2 rooftop. Copeland has one on the shelf.",
			estimated_amount: 980.0,
			preauth_requested_at: hrsAgo(2),
			created_at: hrsAgo(2),
			allocations: { create: [{ job_id: job2.id, job_visit_id: visit2.id, amount: 980.0 }] },
		},
	});

	// 3. preauth_approved — cleared to spend, tech still at the counter.
	const fpPreauthApproved = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "preauth_approved",
			reason: "Condenser fan motor and matching capacitor for the Williams call.",
			estimated_amount: 640.0,
			preauth_requested_at: hrsAgo(5),
			preauth_decided_at: hrsAgo(4),
			preauth_by_id: dispatcher.id,
			preauth_note: "Approved up to 640. Get the itemized receipt, not the card slip.",
			created_at: hrsAgo(5),
			allocations: { create: [{ job_id: job4.id, job_visit_id: visit8.id, amount: 640.0 }] },
		},
	});

	// 4. preauth_denied — the denial is the control working, and it stays in the
	// record rather than vanishing from the queue.
	const fpPreauthDenied = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "preauth_denied",
			reason: "Retail replacement for the Anderson blower motor.",
			estimated_amount: 1250.0,
			preauth_requested_at: daysFromNow(-2),
			preauth_decided_at: daysFromNow(-2),
			preauth_by_id: dispatcher.id,
			preauth_note: "We have two on Truck 4. Swing by the shop — do not buy this at retail.",
			created_at: daysFromNow(-2),
			allocations: { create: [{ job_id: job3.id, job_visit_id: visit3.id, amount: 1250.0 }] },
		},
	});

	// 5. pending_review — the clean case: OCR ran, every line verified, mapped
	// lines carry a disposition, no flags. This is what "approve" should feel like.
	const cleanLines: SeedPurchaseLine[] = [
		{
			description: "CONTACTOR 2P 40A 24V",
			quantity: 2,
			unit_price: 28.0,
			inventory_item_id: invContactor.id,
			disposition: "receive",
			disposition_location: "warehouse",
			ocr_confidence: 0.972,
		},
		{
			description: "HSI IGNITER UNIV",
			quantity: 1,
			unit_price: 42.4,
			inventory_item_id: invIgniter.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van12.id,
			ocr_confidence: 0.944,
		},
		{
			// A named consumable the shop does not stock: the unmapped +
			// non_stock fixture, at the confidence that trips the low-read mark.
			description: "RTV SILICONE HI-TEMP 10.3OZ",
			quantity: 1,
			unit_price: 18.75,
			disposition: "non_stock",
			ocr_confidence: 0.611,
		},
	];
	const cleanReceipt = receiptImage("FERGUSON 418", "Today 09:12", "126.82", [
		["CONTACTOR 2P 40A 24V  x2", "56.00"],
		["HSI IGNITER UNIV      x1", "42.40"],
		["RTV SILICONE HI-TEMP  x1", "18.75"],
		["TAX", "9.67"],
	]);
	const fpClean = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "pending_review",
			reason: "Contactor failed on the Johnson follow-up; picked up a spare igniter while there.",
			vendor_name: "FERGUSON #418",
			supplier_id: supplierFerguson.id,
			purchased_at: hrsAgo(6),
			subtotal: 117.15,
			tax_amount: 9.67,
			total: 126.82,
			receipt_image_url: cleanReceipt,
			receipt_image_hash: receiptHash(cleanReceipt),
			captured_at: hrsAgo(6),
			capture_lat: 43.8124,
			capture_lng: -91.2568,
			capture_accuracy_m: 12,
			submitted_at: hrsAgo(5),
			ocr_status: "succeeded",
			ocr_provider: "mindee",
			ocr_raw: { provider: "mindee", document_type: "receipt", seeded: true },
			ocr_field_confidence: { vendor_name: 0.98, purchased_at: 0.96, total: 0.99, tax_amount: 0.87 },
			ocr_lines: ocrSnapshot(cleanLines),
			ocr_completed_at: hrsAgo(6),
			ocr_line_count: 3,
			ocr_corrections: 1,
			flags: [],
			created_at: hrsAgo(6),
			lines: { create: purchaseLines(cleanLines, hrsAgo(5)) },
			allocations: { create: [{ job_id: job1.id, job_visit_id: visit1.id, amount: 126.82 }] },
		},
		include: { lines: true },
	});

	// 6. pending_review, flagged — the receipt total does not agree with its own
	// lines, capture had no location, and it is the third Ferguson run today.
	const flaggedLines: SeedPurchaseLine[] = [
		{
			description: "COPPER LINE SET 3/4 X 50FT",
			quantity: 1,
			unit_price: 289.0,
			inventory_item_id: invLineSet.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van12.id,
			ocr_confidence: 0.918,
		},
		{
			description: "R-410A 25LB CYL",
			quantity: 1,
			unit_price: 62.0,
			inventory_item_id: invRefrigerant.id,
			disposition: "receive",
			disposition_location: "warehouse",
			ocr_confidence: 0.874,
		},
	];
	const flaggedReceipt = receiptImage("FERGUSON 418", "Today 11:40", "402.00", [
		["COPPER LINE SET 3/4  x1", "289.00"],
		["R-410A 25LB CYL      x1", "62.00"],
		["TAX", "28.96"],
	]);
	const fpFlagged = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "pending_review",
			reason: "Line set damaged during the Bldg 2 install — replaced on the spot.",
			vendor_name: "FERGUSON #418",
			supplier_id: supplierFerguson.id,
			purchased_at: hrsAgo(4),
			subtotal: 351.0,
			tax_amount: 28.96,
			// Deliberately not 379.96: this is the total_mismatch fixture.
			total: 402.0,
			receipt_image_url: flaggedReceipt,
			receipt_image_hash: receiptHash(flaggedReceipt),
			captured_at: hrsAgo(4),
			submitted_at: hrsAgo(3),
			ocr_status: "succeeded",
			ocr_provider: "mindee",
			ocr_raw: { provider: "mindee", document_type: "receipt", seeded: true },
			ocr_field_confidence: { vendor_name: 0.95, purchased_at: 0.62, total: 0.41, tax_amount: 0.55 },
			ocr_lines: ocrSnapshot(flaggedLines),
			ocr_completed_at: hrsAgo(4),
			ocr_line_count: 2,
			ocr_corrections: 0,
			flags: [
				{
					code: "total_mismatch",
					message: "Receipt total 402.00 does not match lines plus tax (379.96)",
				},
				GEO_MISSING,
				{ code: "velocity", message: "3 purchases at FERGUSON #418 on the same day" },
			],
			created_at: hrsAgo(4),
			lines: { create: purchaseLines(flaggedLines, hrsAgo(3)) },
			allocations: { create: [{ job_id: job2.id, job_visit_id: visit2.id, amount: 402.0 }] },
		},
		include: { lines: true },
	});

	// 7. queried — sent back with a note; editable again on the tech's side. Also
	// the third Ferguson purchase today, which is what makes the velocity flag true.
	const queriedLines: SeedPurchaseLine[] = [
		{ description: "1/2 EMT CONDUIT 10FT", quantity: 3, unit_price: 12.68, disposition: "non_stock" },
	];
	const queriedReceipt = receiptImage("FERGUSON 418", "Today 13:05", "41.18", [
		["1/2 EMT CONDUIT 10FT x3", "38.04"],
		["TAX", "3.14"],
	]);
	const fpQueried = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "queried",
			reason: "Conduit for the disconnect relocate.",
			vendor_name: "FERGUSON #418",
			supplier_id: supplierFerguson.id,
			purchased_at: hrsAgo(3),
			subtotal: 38.04,
			tax_amount: 3.14,
			total: 41.18,
			receipt_image_url: queriedReceipt,
			receipt_image_hash: receiptHash(queriedReceipt),
			captured_at: hrsAgo(3),
			submitted_at: hrsAgo(2),
			reviewed_at: hrsAgo(1),
			reviewed_by_id: dispatcher2.id,
			review_note: "Which job is the conduit for? Point it at one or split the amount.",
			ocr_status: "skipped",
			flags: [GEO_MISSING],
			created_at: hrsAgo(3),
			lines: { create: purchaseLines(queriedLines, hrsAgo(2)) },
			allocations: { create: [{ job_id: job2.id, job_visit_id: visit2.id, amount: 41.18 }] },
		},
		include: { lines: true },
	});

	// 8. pending_second_signoff — under John's 750 ceiling but over the org's 500
	// threshold, so one approval is not enough to release it.
	const signoffLines: SeedPurchaseLine[] = [
		{
			description: "COMPRESSOR SCROLL 3TON R410A",
			quantity: 1,
			unit_price: 565.0,
			inventory_item_id: invCompressor.id,
			disposition: "receive",
			disposition_location: "warehouse",
			ocr_confidence: 0.933,
		},
	];
	const signoffReceipt = receiptImage("COPELAND DISTRIBUTION", "Yesterday 15:22", "611.61", [
		["COMPRESSOR SCROLL 3T x1", "565.00"],
		["TAX", "46.61"],
	]);
	const fpSignoff = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "pending_second_signoff",
			reason: "Emergency compressor swap — tenant space was down.",
			vendor_name: "Copeland Distribution",
			supplier_id: supplierCopeland.id,
			purchased_at: daysFromNow(-1),
			subtotal: 565.0,
			tax_amount: 46.61,
			total: 611.61,
			receipt_image_url: signoffReceipt,
			receipt_image_hash: receiptHash(signoffReceipt),
			captured_at: daysFromNow(-1),
			capture_lat: 43.8129,
			capture_lng: -91.2559,
			capture_accuracy_m: 8,
			submitted_at: daysFromNow(-1),
			reviewed_at: hrsAgo(20),
			reviewed_by_id: dispatcher2.id,
			review_note: "Looks right to me — over threshold, needs Alex as well.",
			ocr_status: "succeeded",
			ocr_provider: "mindee",
			ocr_raw: { provider: "mindee", document_type: "receipt", seeded: true },
			ocr_field_confidence: { vendor_name: 0.99, purchased_at: 0.97, total: 0.98, tax_amount: 0.93 },
			ocr_lines: ocrSnapshot(signoffLines),
			ocr_completed_at: daysFromNow(-1),
			ocr_line_count: 1,
			ocr_corrections: 0,
			flags: [],
			created_at: daysFromNow(-1),
			lines: { create: purchaseLines(signoffLines, daysFromNow(-1)) },
			allocations: { create: [{ job_id: job2.id, job_visit_id: visit2.id, amount: 611.61 }] },
		},
		include: { lines: true },
	});

	// 9. approved — the only status that moves stock. Vendor is free text with no
	// supplier FK on purpose: not every counter is one of our two suppliers.
	const approvedLines: SeedPurchaseLine[] = [
		{
			description: "DUCT MASTIC 1GAL",
			quantity: 2,
			unit_price: 24.5,
			inventory_item_id: provDuctSealant.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van12.id,
		},
		{
			description: "FOIL TAPE 2IN X 60YD",
			quantity: 2,
			unit_price: 22.25,
			disposition: "non_stock",
		},
	];
	const approvedReceipt = receiptImage("MENARDS ONALASKA", "3 days ago", "101.21", [
		["DUCT MASTIC 1GAL     x2", "49.00"],
		["FOIL TAPE 2IN X 60YD x2", "44.50"],
		["TAX", "7.71"],
	]);
	const fpApproved = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "approved",
			reason: "Duct leakage found mid-PM; sealed the return plenum before leaving.",
			vendor_name: "Menards Onalaska",
			purchased_at: daysFromNow(-3),
			subtotal: 93.5,
			tax_amount: 7.71,
			total: 101.21,
			receipt_image_url: approvedReceipt,
			receipt_image_hash: receiptHash(approvedReceipt),
			captured_at: daysFromNow(-3),
			capture_lat: 43.8901,
			capture_lng: -91.2318,
			capture_accuracy_m: 22,
			submitted_at: daysFromNow(-3),
			reviewed_at: daysFromNow(-2),
			reviewed_by_id: dispatcher.id,
			review_note: "Approved. Mastic is on Van 12 — reconcile the provisional item when you can.",
			ocr_status: "skipped",
			flags: [],
			created_at: daysFromNow(-3),
			lines: { create: purchaseLines(approvedLines, daysFromNow(-3)) },
			allocations: { create: [{ job_id: job1.id, job_visit_id: visit1.id, amount: 101.21 }] },
		},
		include: { lines: true },
	});

	// 10. rejected — refused with a reason, so the Decided tab is not all yes.
	const rejectedLines: SeedPurchaseLine[] = [
		{ description: "18V IMPACT DRIVER KIT", quantity: 1, unit_price: 164.85, disposition: "non_stock" },
	];
	const rejectedReceipt = receiptImage("HOME DEPOT 4912", "6 days ago", "178.45", [
		["18V IMPACT DRIVER KIT", "164.85"],
		["TAX", "13.60"],
	]);
	const fpRejected = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "rejected",
			reason: "Impact driver died on the roof.",
			vendor_name: "Home Depot #4912",
			purchased_at: daysFromNow(-6),
			subtotal: 164.85,
			tax_amount: 13.6,
			total: 178.45,
			receipt_image_url: rejectedReceipt,
			receipt_image_hash: receiptHash(rejectedReceipt),
			captured_at: daysFromNow(-6),
			submitted_at: daysFromNow(-6),
			reviewed_at: daysFromNow(-5),
			reviewed_by_id: dispatcher.id,
			review_note: "Tools are a shop purchase, not a job cost. File it with the tool allowance.",
			// The provider answered and found nothing, which is a failure; `skipped`
			// above is the no-provider-configured success path.
			ocr_status: "failed",
			ocr_provider: "mindee",
			ocr_error: "Provider returned no line items for this document",
			flags: [GEO_MISSING],
			created_at: daysFromNow(-6),
			lines: { create: purchaseLines(rejectedLines, daysFromNow(-6)) },
			allocations: { create: [{ job_id: job3.id, job_visit_id: visit3.id, amount: 178.45 }] },
		},
		include: { lines: true },
	});

	// 11. refund — same shape as the purchase it reverses, approved but not yet
	// settled, so the queue still shows money owed back.
	const refundLines: SeedPurchaseLine[] = [
		{
			description: "DUCT MASTIC 1GAL (RETURN)",
			quantity: 1,
			unit_price: 24.5,
			inventory_item_id: provDuctSealant.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van12.id,
		},
	];
	const refundReceipt = receiptImage("MENARDS ONALASKA", "2 days ago RETURN", "26.52", [
		["DUCT MASTIC 1GAL     x1", "24.50"],
		["TAX", "2.02"],
	]);
	const fpRefund = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech1.id,
			status: "approved",
			kind: "refund",
			parent_purchase_id: fpApproved.id,
			reason: "One pail unopened — returned to the counter.",
			vendor_name: "Menards Onalaska",
			purchased_at: daysFromNow(-2),
			subtotal: 24.5,
			tax_amount: 2.02,
			total: 26.52,
			receipt_image_url: refundReceipt,
			receipt_image_hash: receiptHash(refundReceipt),
			captured_at: daysFromNow(-2),
			submitted_at: daysFromNow(-2),
			reviewed_at: daysFromNow(-2),
			reviewed_by_id: dispatcher.id,
			review_note: "Credit slip matches. Watch for it on the statement.",
			ocr_status: "skipped",
			// Stamped by review on an approved refund, cleared when the money lands.
			flags: [{ code: "refund_unsettled", message: "Approved — waiting on the credit to actually land" }],
			created_at: daysFromNow(-2),
			lines: { create: purchaseLines(refundLines, daysFromNow(-2)) },
			allocations: { create: [{ job_id: job1.id, job_visit_id: visit1.id, amount: 26.52 }] },
		},
		include: { lines: true },
	});

	// 12. Maria's pending_review — a second technician in the queue, buying the
	// motor that became the tech_submission provisional item above.
	const mariaLines: SeedPurchaseLine[] = [
		{
			description: "COND FAN MOTOR 1/6HP",
			quantity: 1,
			unit_price: 132.75,
			inventory_item_id: provCondFanMotor.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van8.id,
			ocr_confidence: 0.802,
		},
	];
	const mariaReceipt = receiptImage("COPELAND DISTRIBUTION", "Today 10:31", "143.70", [
		["COND FAN MOTOR 1/6HP x1", "132.75"],
		["TAX", "10.95"],
	]);
	const fpMaria = await db.field_purchase.create({
		data: {
			organization_id: org.id,
			technician_id: tech2.id,
			status: "pending_review",
			reason: "Condenser fan motor locked up at Riverside — unit was down.",
			vendor_name: "Copeland Distribution",
			supplier_id: supplierCopeland.id,
			purchased_at: hrsAgo(7),
			subtotal: 132.75,
			tax_amount: 10.95,
			total: 143.7,
			receipt_image_url: mariaReceipt,
			receipt_image_hash: receiptHash(mariaReceipt),
			captured_at: hrsAgo(7),
			submitted_at: hrsAgo(6),
			ocr_status: "succeeded",
			ocr_provider: "mindee",
			ocr_raw: { provider: "mindee", document_type: "receipt", seeded: true },
			ocr_field_confidence: { vendor_name: 0.91, purchased_at: 0.88, total: 0.94, tax_amount: 0.72 },
			ocr_lines: ocrSnapshot(mariaLines),
			ocr_completed_at: hrsAgo(7),
			ocr_line_count: 1,
			ocr_corrections: 1,
			flags: [GEO_MISSING],
			created_at: hrsAgo(7),
			lines: { create: purchaseLines(mariaLines, hrsAgo(6)) },
			allocations: { create: [{ job_id: job5.id, job_visit_id: weeklyVisit1.id, amount: 143.7 }] },
		},
		include: { lines: true },
	});

	// Stock effect of the approved pair, written through recordMovements with the
	// same shape applyApprovalStockEffect / applyRefundReversal produce, so the
	// ledger reads identically whether the row was seeded or reviewed live.
	// Chronological: the intake has to land before the return draws it back down.
	const masticIntakeLine = fpApproved.lines.find(
		(l) => l.inventory_item_id === provDuctSealant.id,
	)!;
	await moveAt(
		daysFromNow(-2),
		dispActor,
		[
			{
				inventory_item_id: provDuctSealant.id,
				qty: 2,
				from_location_type: "external",
				to_location_type: "vehicle",
				to_vehicle_id: van12.id,
				reason: "supplier_purchase",
				unit_cost: 24.5,
				field_purchase_line_id: masticIntakeLine.id,
				note: "Field purchase approved",
			},
		],
		{ allowUntracked: true },
	);

	await moveAt(
		daysFromNow(-2),
		dispActor,
		[
			{
				inventory_item_id: provDuctSealant.id,
				qty: 1,
				from_location_type: "vehicle",
				from_vehicle_id: van12.id,
				to_location_type: "external",
				reason: "reversal",
				unit_cost: 24.5,
				field_purchase_line_id: fpRefund.lines[0].id,
				note: "Field purchase refund approved",
			},
		],
		{ allowUntracked: true },
	);

	// What submitting put on the customer's bill. A `non_stock` line is the spec's
	// "Consumed on job", charged at SUBMIT rather than approval - a visit invoiced
	// before a dispatcher reaches the queue would otherwise never bill the part.
	// Rejecting is what takes it back off.
	const billLine = async (
		purchase: { id: string; lines: { id: string; description: string; quantity: unknown; unit_price: unknown }[] },
		description: string,
		visitId: string,
		at: Date,
	) => {
		const line = purchase.lines.find((l) => l.description === description);
		if (!line) return;
		const quantity = Number(line.quantity);
		const unitPrice = Number(line.unit_price);
		const billed = await db.job_visit_line_item.create({
			data: {
				visit_id: visitId,
				name: line.description,
				quantity,
				unit_price: unitPrice,
				total: Number((quantity * unitPrice).toFixed(2)),
				source: "field_addition",
				item_type: "material",
				// Billed, never in our inventory — so completion settles it without
				// moving stock it never held.
				disposition: "non_stock",
				sort_order: 0,
				created_at: at,
			},
		});
		await db.field_purchase_line.update({
			where: { id: line.id },
			data: { visit_line_item_id: billed.id },
		});
		// The seeded visits carry hand-set totals rather than derived ones, so a new
		// billable line has to move them or the visit reads as costing less than its
		// own lines. Added to both, which keeps total = subtotal + tax.
		await db.job_visit.update({
			where: { id: visitId },
			data: {
				subtotal: { increment: billed.total },
				total: { increment: billed.total },
			},
		});
	};

	await billLine(fpApproved, "FOIL TAPE 2IN X 60YD", visit1.id, hrsAgo(20));
	await billLine(fpQueried, "1/2 EMT CONDUIT 10FT", visit2.id, hrsAgo(2));

	// A line names the job it served, and every seeded receipt covers exactly one —
	// so each takes the only job there was. What `settleAllocations` does on any
	// real save; the seed writes rows straight past it.
	for (const alloc of await db.field_purchase_job_allocation.findMany({
		where: { field_purchase: { organization_id: org.id } },
		select: { id: true, field_purchase_id: true },
	})) {
		await db.field_purchase_line.updateMany({
			where: { field_purchase_id: alloc.field_purchase_id },
			data: { allocation_id: alloc.id },
		});
	}

	// Append-only trail. Grants and purchases share this table so one query
	// answers "what happened to this technician's authority and spend".
	await db.field_purchase_event.createMany({
		data: [
			{ organization_id: org.id, field_purchase_id: fpDraft.id, type: "purchase.created", actor_type: "technician", actor_id: tech1.id, detail: { estimated_amount: "85.00" }, at: minsAgo(25) },

			{ organization_id: org.id, field_purchase_id: fpPreauthPending.id, type: "purchase.created", actor_type: "technician", actor_id: tech1.id, detail: { estimated_amount: "980.00" }, at: hrsAgo(2) },
			{ organization_id: org.id, field_purchase_id: fpPreauthPending.id, type: "purchase.preauth_requested", actor_type: "technician", actor_id: tech1.id, detail: { breaches: [{ code: "per_transaction", limit: "750.00", would_be: "980.00" }] }, at: hrsAgo(2) },

			{ organization_id: org.id, field_purchase_id: fpPreauthApproved.id, type: "purchase.preauth_requested", actor_type: "technician", actor_id: tech1.id, detail: {}, at: hrsAgo(5) },
			{ organization_id: org.id, field_purchase_id: fpPreauthApproved.id, type: "purchase.preauth_approved", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { note: "Approved up to 640." }, at: hrsAgo(4) },

			{ organization_id: org.id, field_purchase_id: fpPreauthDenied.id, type: "purchase.preauth_requested", actor_type: "technician", actor_id: tech1.id, detail: {}, at: daysFromNow(-2) },
			{ organization_id: org.id, field_purchase_id: fpPreauthDenied.id, type: "purchase.preauth_denied", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { note: "We have two on Truck 4." }, at: daysFromNow(-2) },

			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.created", actor_type: "technician", actor_id: tech1.id, detail: {}, at: hrsAgo(6) },
			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.receipt_captured", actor_type: "technician", actor_id: tech1.id, detail: { ocr_status: "pending" }, at: hrsAgo(6) },
			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.ocr_completed", actor_type: "system", detail: { provider: "mindee", line_count: 3 }, at: hrsAgo(6) },
			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.lines_replaced", actor_type: "technician", actor_id: tech1.id, detail: { corrections: 1 }, at: hrsAgo(5) },
			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.lines_verified", actor_type: "technician", actor_id: tech1.id, detail: { count: 3 }, at: hrsAgo(5) },
			{ organization_id: org.id, field_purchase_id: fpClean.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "126.82" }, at: hrsAgo(5) },

			{ organization_id: org.id, field_purchase_id: fpFlagged.id, type: "purchase.receipt_captured", actor_type: "technician", actor_id: tech1.id, detail: {}, at: hrsAgo(4) },
			{ organization_id: org.id, field_purchase_id: fpFlagged.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "402.00", flags: ["total_mismatch", "geo_missing", "velocity"] }, at: hrsAgo(3) },

			{ organization_id: org.id, field_purchase_id: fpQueried.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "41.18" }, at: hrsAgo(2) },
			{ organization_id: org.id, field_purchase_id: fpQueried.id, type: "purchase.query", actor_type: "dispatcher", actor_id: dispatcher2.id, detail: { note: "Which job is the conduit for?" }, at: hrsAgo(1) },

			{ organization_id: org.id, field_purchase_id: fpSignoff.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "611.61" }, at: daysFromNow(-1) },
			{ organization_id: org.id, field_purchase_id: fpSignoff.id, type: "purchase.approve", actor_type: "dispatcher", actor_id: dispatcher2.id, detail: { routed_to: "pending_second_signoff", threshold: "500.00" }, at: hrsAgo(20) },

			{ organization_id: org.id, field_purchase_id: fpApproved.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "101.21" }, at: daysFromNow(-3) },
			{ organization_id: org.id, field_purchase_id: fpApproved.id, type: "purchase.approve", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { intake_lines: 1 }, at: daysFromNow(-2) },
			{ organization_id: org.id, field_purchase_id: fpApproved.id, type: "purchase.refund_started", actor_type: "technician", actor_id: tech1.id, detail: { refund_id: fpRefund.id }, at: daysFromNow(-2) },

			{ organization_id: org.id, field_purchase_id: fpRejected.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "178.45" }, at: daysFromNow(-6) },
			{ organization_id: org.id, field_purchase_id: fpRejected.id, type: "purchase.reject", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { note: "Tools are a shop purchase." }, at: daysFromNow(-5) },

			{ organization_id: org.id, field_purchase_id: fpRefund.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech1.id, detail: { total: "26.52" }, at: daysFromNow(-2) },
			{ organization_id: org.id, field_purchase_id: fpRefund.id, type: "purchase.approve", actor_type: "dispatcher", actor_id: dispatcher.id, detail: { reversed_qty: 1 }, at: daysFromNow(-2) },

			{ organization_id: org.id, field_purchase_id: fpMaria.id, type: "purchase.submitted", actor_type: "technician", actor_id: tech2.id, detail: { total: "143.70" }, at: hrsAgo(6) },
		],
	});

	await db.technician_notification.createMany({
		data: [
			{ technician_id: tech1.id, type: "field_purchase_preauth", title: "Purchase pre-approved", body: "Go ahead with the purchase up to 640.00.", action_url: `/technician/purchases/${fpPreauthApproved.id}`, created_at: hrsAgo(4) },
			{ technician_id: tech1.id, type: "field_purchase_reviewed", title: "Purchase needs a change", body: "Which job is the conduit for? Point it at one or split the amount.", action_url: `/technician/purchases/${fpQueried.id}`, created_at: hrsAgo(1) },
			{ technician_id: tech1.id, type: "field_purchase_reviewed", title: "Purchase rejected", body: "Tools are a shop purchase, not a job cost. File it with the tool allowance.", action_url: `/technician/purchases/${fpRejected.id}`, read_at: daysFromNow(-5), created_at: daysFromNow(-5) },
			{ technician_id: tech2.id, type: "field_purchase_reviewed", title: "Purchase submitted", body: "Your 143.70 purchase is with dispatch for review.", action_url: `/technician/purchases/${fpMaria.id}`, read_at: hrsAgo(5), created_at: hrsAgo(6) },
		],
	});

	await db.log.createMany({
		data: [
			{ organization_id: org.id, event_type: "field_purchase_grant.granted", action: "created", entity_type: "field_purchase_grant", entity_id: grantSmith.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { per_transaction_limit: { old: "400.00", new: "750.00" } }, timestamp: daysFromNow(-45) },
			{ organization_id: org.id, event_type: "field_purchase_grant.revoked", action: "updated", entity_type: "field_purchase_grant", entity_id: grantPark.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { is_active: { old: true, new: false } }, timestamp: daysFromNow(-12) },
			{ organization_id: org.id, event_type: "field_purchase.submitted", action: "updated", entity_type: "field_purchase", entity_id: fpClean.id, actor_type: "technician", actor_id: tech1.id, actor_name: tech1.name, changes: { total: { old: null, new: 126.82 } }, timestamp: hrsAgo(5) },
			{ organization_id: org.id, event_type: "field_purchase.submitted", action: "updated", entity_type: "field_purchase", entity_id: fpFlagged.id, actor_type: "technician", actor_id: tech1.id, actor_name: tech1.name, changes: { flags: { old: [], new: ["total_mismatch", "geo_missing", "velocity"] } }, timestamp: hrsAgo(3) },
			{ organization_id: org.id, event_type: "field_purchase.approved", action: "updated", entity_type: "field_purchase", entity_id: fpApproved.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { status: { old: "pending_review", new: "approved" } }, timestamp: daysFromNow(-2) },
			{ organization_id: org.id, event_type: "inventory.created", action: "created", entity_type: "inventory_item", entity_id: provDuctSealant.id, actor_type: "technician", actor_id: tech1.id, actor_name: tech1.name, changes: { provisional: { old: null, new: true }, origin: { old: null, new: "field_purchase" } }, timestamp: daysFromNow(-2) },
		],
	});

	// ============================================================================
	// Shop Purchases (POs) — separate from field_purchase above; these are the
	// `purchase`/`purchase_line` rows the "Link a purchase" search on the vehicle
	// maintenance modal reads via disposition_vehicle_id.
	// ============================================================================

	const poVan12Filters = await db.purchase.create({
		data: {
			organization_id: org.id,
			status: "received",
			purchase_number: "PO-2041",
			supplier_id: supplierFerguson.id,
			vendor_name: supplierFerguson.name,
			purchased_at: daysFromNow(-18),
			subtotal: 191.0,
			total: 191.0,
		},
	});
	await db.purchase_line.createMany({
		data: [
			{
				purchase_id: poVan12Filters.id,
				description: "Air Filter 16x25x1 MERV-8 (case of 12)",
				quantity: 12,
				unit_price: 8.5,
				line_total: 102.0,
				inventory_item_id: invFilter.id,
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: van12.id,
				quantity_recieved: 12,
				received_at: daysFromNow(-18),
			},
			{
				purchase_id: poVan12Filters.id,
				description: "Contactor 2-Pole 40A 24V",
				quantity: 2,
				unit_price: 28.0,
				line_total: 56.0,
				inventory_item_id: invContactor.id,
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: van12.id,
				quantity_recieved: 2,
				received_at: daysFromNow(-18),
			},
		],
	});

	const poVan8Refrigerant = await db.purchase.create({
		data: {
			organization_id: org.id,
			status: "received",
			purchase_number: "PO-2052",
			supplier_id: supplierCopeland.id,
			vendor_name: supplierCopeland.name,
			purchased_at: daysFromNow(-9),
			subtotal: 340.0,
			total: 340.0,
		},
	});
	const van8RefrigerantLine = await db.purchase_line.create({
		data: {
			purchase_id: poVan8Refrigerant.id,
			description: "R-410A Refrigerant 25lb Cylinder",
			quantity: 2,
			unit_price: 170.0,
			line_total: 340.0,
			inventory_item_id: invRefrigerant.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: van8.id,
			quantity_recieved: 2,
			received_at: daysFromNow(-9),
		},
	});

	// No supplier record — vendor as free text, same "not every vendor has a
	// row" mix the field_purchase fixtures exercise above.
	const poTruck4Compressor = await db.purchase.create({
		data: {
			organization_id: org.id,
			status: "ordered",
			purchase_number: "PO-2058",
			vendor_name: "AC Wholesale Direct",
			purchased_at: daysFromNow(-2),
			subtotal: 610.0,
			total: 610.0,
		},
	});
	const truck4CompressorLine = await db.purchase_line.create({
		data: {
			purchase_id: poTruck4Compressor.id,
			description: "Compressor 3-Ton Scroll R-410A — spare stock",
			quantity: 1,
			unit_price: 610.0,
			line_total: 610.0,
			inventory_item_id: invCompressor.id,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: truck4.id,
		},
	});

	const poTruck4Consumables = await db.purchase.create({
		data: {
			organization_id: org.id,
			status: "received",
			purchase_number: "PO-2063",
			supplier_id: supplierFerguson.id,
			vendor_name: supplierFerguson.name,
			purchased_at: daysFromNow(-1),
			subtotal: 132.0,
			total: 132.0,
		},
	});
	await db.purchase_line.createMany({
		data: [
			{
				purchase_id: poTruck4Consumables.id,
				description: "Capacitor 45+5 MFD 440V Round",
				quantity: 4,
				unit_price: 22.0,
				line_total: 88.0,
				inventory_item_id: invCapacitor.id,
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: truck4.id,
				quantity_recieved: 4,
				received_at: daysFromNow(-1),
			},
			{
				purchase_id: poTruck4Consumables.id,
				description: "Hot Surface Igniter (Universal)",
				quantity: 2,
				unit_price: 22.0,
				line_total: 44.0,
				inventory_item_id: invIgniter.id,
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: truck4.id,
				quantity_recieved: 2,
				received_at: daysFromNow(-1),
			},
		],
	});

	// ============================================================================
	// Vehicle Maintenance Records — some linked back to the purchases/field
	// purchases above via source_purchase_line_id / source_field_purchase_line_id,
	// so "Link a purchase" on the maintenance modal has real hits to find.
	// Van 12 carries one record per category, so its summary tiles are never
	// all "No records yet".
	// ============================================================================

	const fpCleanIgniterLine = fpClean.lines.find((l) => l.description.includes("IGNITER"))!;

	await db.vehicle_maintenance_record.createMany({
		data: [
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "repair",
				performed_at: daysFromNow(-6),
				odometer_mi: 41500,
				cost: 42.4,
				vendor_name: "Ferguson",
				notes: "Hot surface igniter replaced during the Johnson follow-up.",
				performed_by_tech_id: tech1.id,
				source_field_purchase_line_id: fpCleanIgniterLine.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "oil_change",
				performed_at: daysFromNow(-38),
				odometer_mi: 39200,
				interval_miles: 5000,
				interval_months: 6,
				cost: 68.5,
				vendor_name: "Iowa 80 Truck Stop",
				notes: "Full synthetic 5W-30, filter replaced.",
				performed_by_tech_id: tech1.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "tire",
				performed_at: daysFromNow(-95),
				odometer_mi: 36800,
				interval_months: 12,
				cost: 598.0,
				vendor_name: "Discount Tire",
				notes: "4 new all-season, alignment included.",
				performed_by_id: dispatcher.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "brake",
				performed_at: daysFromNow(-160),
				odometer_mi: 33500,
				interval_miles: 12000,
				cost: 274.99,
				vendor_name: "Ferguson",
				notes: "Front pads and rotors replaced — pads were down to 2mm.",
				performed_by_tech_id: tech1.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "inspection",
				performed_at: daysFromNow(-210),
				odometer_mi: 31200,
				interval_months: 12,
				cost: 35.0,
				vendor_name: "DOT Inspection Station",
				notes: "Annual DOT inspection — passed, no defects noted.",
				performed_by_id: dispatcher.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "registration",
				performed_at: daysFromNow(-240),
				interval_months: 12,
				cost: 12.0,
				vendor_name: "DMV",
				notes: "Annual renewal, sticker mailed.",
				performed_by_id: dispatcher.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "other",
				performed_at: daysFromNow(-270),
				odometer_mi: 28900,
				cost: 15.0,
				notes: "Windshield wiper blades replaced, no vendor receipt kept.",
				performed_by_tech_id: tech1.id,
			},
			{
				organization_id: org.id,
				vehicle_id: van8.id,
				category: "repair",
				performed_at: daysFromNow(-9),
				odometer_mi: 28750,
				interval_months: 12,
				cost: 340.0,
				vendor_name: "Copeland Distribution",
				notes: "R-410A recharge — slow leak at the schrader valve, monitor next service.",
				performed_by_id: dispatcher.id,
				source_purchase_line_id: van8RefrigerantLine.id,
			},
			{
				organization_id: org.id,
				vehicle_id: truck4.id,
				category: "repair",
				performed_at: daysFromNow(-2),
				odometer_mi: 52100,
				interval_miles: 25000,
				cost: 610.0,
				vendor_name: "AC Wholesale Direct",
				notes: "Spare compressor received and staged on the truck.",
				performed_by_id: dispatcher2.id,
				source_purchase_line_id: truck4CompressorLine.id,
			},
		],
	});

	// ============================================================================
	// Vehicle Maintenance Reminders — mix of one-time (explicit due_at) and
	// repeating (anchored on the matching record above + interval) so the
	// overdue/due-soon/upcoming classification and the due-reminder notification
	// feature both have real data to exercise. Truck 4 is the unassigned spare
	// (no current_technician) — its reminders should still surface to
	// dispatchers but never page a technician.
	// ============================================================================

	await db.vehicle_maintenance_reminder.createMany({
		data: [
			// Van 12 — overdue, upcoming (repeating, baseline = the oil_change record above), due-soon.
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "registration",
				title: "Registration Renewal",
				repeats: false,
				due_at: daysFromNow(-3),
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "oil_change",
				title: "Oil & Filter Change",
				repeats: true,
				interval_miles: 5000,
				interval_unit: "months",
				interval_count: 6,
				baseline_at: daysFromNow(-38),
				baseline_odometer_mi: 39200,
			},
			{
				organization_id: org.id,
				vehicle_id: van12.id,
				category: "inspection",
				title: "Annual DOT Inspection",
				repeats: false,
				due_at: daysFromNow(5),
			},
			// Van 8 — overdue brake service, tire due soon.
			{
				organization_id: org.id,
				vehicle_id: van8.id,
				category: "brake",
				title: "Brake Pad Inspection",
				repeats: false,
				due_at: daysFromNow(-10),
			},
			{
				organization_id: org.id,
				vehicle_id: van8.id,
				category: "tire",
				title: "Tire Rotation",
				repeats: false,
				due_at: daysFromNow(4),
			},
			// Truck 4 — spare, unassigned: overdue oil change + upcoming registration.
			{
				organization_id: org.id,
				vehicle_id: truck4.id,
				category: "oil_change",
				title: "Oil & Filter Change",
				repeats: false,
				due_at: daysFromNow(-1),
				due_odometer_mi: 54000,
			},
			{
				organization_id: org.id,
				vehicle_id: truck4.id,
				category: "registration",
				title: "Registration Renewal",
				repeats: false,
				due_at: daysFromNow(20),
			},
		],
	});

	// ============================================================================
	// Document Disputes — quote and invoice contest / resolution fixtures
	// ============================================================================
	//
	// Placed BEFORE the tax post-pass on purpose: every document below is taxed
	// by the real engine from its line items, so the credit adjustments exercise
	// negative-amount tax rather than carrying a hand-computed figure that could
	// drift from what the engine actually does.
	//
	// Organised by what a reviewer needs to see:
	//   open, awaiting resolution ....... Q-0003, Q-0007, INV-0006/7/8
	//   resolved, Revise & Resend ....... Q-0004 → Q-0005, INV-0011 → INV-0012
	//   resolved, Repeal ................ Q-0006
	//   resolved, Issue Adjustment ...... INV-0009 + INV-0010 (credit) + INV-0013 (charge)
	//   lifecycle completion ............ Q-0008 (rejected), Q-0009 (lapsed), INV-0014 (refund)
	//   migration fixture ............... INV-0015

	// ── Q-0003: open dispute, 2 of 3 lines contested ────────────────────────────
	// The everyday case: a Sent quote the client is arguing with. Both outcomes
	// are available, and Cancel Quote is refused while the dispute is open —
	// cancelling would strand the dispute Open forever with no way to close it.
	const quoteDisputed = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0003",
			client_id: client3.id,
			title: "Ductwork Reseal — Upper Floor",
			description:
				"Reseal supply trunk and six branch runs; replace two crushed elbows.",
			status: "Disputed",
			address: client3.address,
			priority: "Medium",
			// Recomputed by the tax post-pass below from the line items; seeded
			// here because subtotal and total are required columns.
			subtotal: 2326.0,
			tax_rate: 0.0825,
			tax_amount: 191.9,
			total: 2517.9,
			issued_at: daysFromNow(-9),
			sent_at: daysFromNow(-9),
			valid_until: daysFromNow(21),
			expires_at: daysFromNow(21),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Duct Sealing Labor (12 hrs)",
						quantity: 12,
						unit_price: 145.0,
						total: 1740.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Sheet Metal Elbow 8in (2)",
						quantity: 2,
						unit_price: 68.0,
						total: 136.0,
						item_type: "material",
						sort_order: 1,
					},
					{
						name: "After-hours Access Surcharge",
						quantity: 1,
						unit_price: 450.0,
						total: 450.0,
						item_type: "other",
						sort_order: 2,
					},
				],
			},
		},
		include: { line_items: { orderBy: { sort_order: "asc" } } },
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "quote",
			quote_id: quoteDisputed.id,
			status: "Open",
			reason: "Client says the after-hours surcharge was never discussed, and disputes 12 hours of labour for a job we quoted verbally at 8.",
			// Two of the three lines — drives the banner's "2 of 3 lines
			// contested" count and pre-seeds the resolve modal's line picker.
			contested_line_item_ids: [
				quoteDisputed.line_items[0]!.id,
				quoteDisputed.line_items[2]!.id,
			],
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-2),
		},
	});

	// ── Q-0004 → Q-0005: resolved via Revise & Resend ───────────────────────────
	// The original is Revised and immutable; the replacement carries version 2,
	// previous_quote_id, and a validity window measured from its OWN issue date
	// so a revision is never born already expired.
	const quoteSuperseded = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0004",
			client_id: client5.id,
			title: "Boiler Circulator Pump Replacement",
			description:
				"Replace failed circulator pump on the north boiler loop.",
			status: "Revised",
			address: client5.address,
			priority: "High",
			subtotal: 865.0,
			tax_rate: 0.0825,
			tax_amount: 71.36,
			total: 936.36,
			version: 1,
			issued_at: daysFromNow(-20),
			sent_at: daysFromNow(-20),
			valid_until: daysFromNow(10),
			expires_at: daysFromNow(10),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Circulator Pump — Taco 007-F5",
						quantity: 1,
						unit_price: 385.0,
						total: 385.0,
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Install Labor (3 hrs)",
						quantity: 3,
						unit_price: 160.0,
						total: 480.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	const quoteReplacement = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0005",
			client_id: client5.id,
			title: "Boiler Circulator Pump Replacement",
			description:
				"Revised after dispute: labour re-scoped to 2 hours, isolation valves added.",
			status: "Issued",
			address: client5.address,
			priority: "High",
			subtotal: 779.0,
			tax_rate: 0.0825,
			tax_amount: 64.27,
			total: 843.27,
			version: 2,
			previous_quote_id: quoteSuperseded.id,
			issued_at: daysFromNow(-6),
			valid_until: daysFromNow(24),
			expires_at: daysFromNow(24),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Circulator Pump — Taco 007-F5",
						quantity: 1,
						unit_price: 385.0,
						total: 385.0,
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Install Labor (2 hrs)",
						quantity: 2,
						unit_price: 160.0,
						total: 320.0,
						item_type: "labor",
						sort_order: 1,
					},
					{
						name: "Isolation Valve Pair",
						quantity: 1,
						unit_price: 74.0,
						total: 74.0,
						item_type: "material",
						sort_order: 2,
					},
				],
			},
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "quote",
			quote_id: quoteSuperseded.id,
			status: "Resolved",
			reason: "Client disputed 3 hours of labour — says the pump is in an open mechanical room and the job is a 2-hour swap.",
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-8),
			resolution: "ReviseAndResend",
			resolution_note:
				"Agreed. Re-scoped labour to 2 hours and added the isolation valves the client asked for.",
			resolved_by_dispatcher_id: dispatcher.id,
			resolved_at: daysFromNow(-6),
			replacement_quote_id: quoteReplacement.id,
		},
	});

	// ── Q-0006: resolved via Repeal ─────────────────────────────────────────────
	// Terminal. rejection_reason carries the resolution note, and updateQuote
	// refuses every later edit — repealed stays repealed.
	const quoteRepealed = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0006",
			client_id: client1.id,
			title: "Whole-Home Humidifier Install",
			description:
				"Install bypass humidifier on the main supply plenum with humidistat.",
			status: "Cancelled",
			address: client1.address,
			priority: "Low",
			subtotal: 620.0,
			tax_rate: 0.0825,
			tax_amount: 51.15,
			total: 671.15,
			issued_at: daysFromNow(-30),
			sent_at: daysFromNow(-30),
			rejection_reason:
				"Withdrawn after dispute — client's water hardness makes this the wrong product. Recommending a different approach.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Bypass Humidifier — Aprilaire 700",
						quantity: 1,
						unit_price: 620.0,
						total: 620.0,
						item_type: "equipment",
						sort_order: 0,
					},
				],
			},
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "quote",
			quote_id: quoteRepealed.id,
			status: "Resolved",
			reason: "Client disputes the humidifier recommendation — says the last one scaled up within a year.",
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-11),
			resolution: "Repeal",
			resolution_note:
				"Withdrawn after dispute — client's water hardness makes this the wrong product. Recommending a different approach.",
			resolved_by_dispatcher_id: dispatcher.id,
			resolved_at: daysFromNow(-10),
		},
	});

	// ── Q-0007: open dispute where the work is already sold ─────────────────────
	// req1 is ConvertedToJob, so Revise & Resend is disabled with the
	// sibling-sold reason and Repeal is the only outcome offered: once a job
	// exists the quote is no longer the live document.
	const quoteSoldDisputed = await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0007",
			client_id: client1.id,
			request_id: req1.id,
			title: "AC Condenser Coil Replacement",
			description:
				"Replace corroded condenser coil; recover and recharge R-410A.",
			status: "Disputed",
			address: client1.address,
			priority: "High",
			subtotal: 1580.0,
			tax_rate: 0.0825,
			tax_amount: 130.35,
			total: 1710.35,
			issued_at: daysFromNow(-16),
			sent_at: daysFromNow(-16),
			viewed_at: daysFromNow(-15),
			approved_at: daysFromNow(-14),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Condenser Coil — 3 Ton",
						quantity: 1,
						unit_price: 940.0,
						total: 940.0,
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Recovery & Recharge Labor (4 hrs)",
						quantity: 4,
						unit_price: 160.0,
						total: 640.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "quote",
			quote_id: quoteSoldDisputed.id,
			status: "Open",
			reason: "Client approved, then called back disputing the coil price against a competitor's written quote.",
			status_at_open: "Approved",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-1),
		},
	});

	// ── Q-0008: rejected with a reason (D14) ────────────────────────────────────
	// "The client said no" — reachable from the UI now, and it fills the funnel's
	// lost bucket, which could never fill before.
	await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0008",
			client_id: client3.id,
			request_id: reqQuoteRejected.id,
			title: "Attic Insulation Top-Up",
			description:
				"Blow cellulose to R-49 across the main attic; baffle the soffit vents.",
			status: "Rejected",
			address: client3.address,
			priority: "Low",
			subtotal: 1890.0,
			tax_rate: 0.0825,
			tax_amount: 155.93,
			total: 2045.93,
			issued_at: daysFromNow(-25),
			sent_at: daysFromNow(-25),
			viewed_at: daysFromNow(-24),
			rejected_at: daysFromNow(-22),
			rejection_reason:
				"Client is deferring to next budget year — going ahead with the furnace work only.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Blown Cellulose R-49 (1,400 sq ft)",
						quantity: 1400,
						unit_price: 1.35,
						total: 1890.0,
						item_type: "material",
						sort_order: 0,
					},
				],
			},
		},
	});

	// ── Q-0009: Sent but already past expires_at ────────────────────────────────
	// The sweep runs every 5 minutes, so the stored status lags reality between
	// runs. The detail page derives an "Expired" badge from expires_at rather
	// than trusting the status alone; this is the fixture that shows it. Running
	// the sweep once flips this row to Expired.
	await db.quote.create({
		data: {
			organization_id: org.id,
			quote_number: "Q-0009",
			client_id: client2.id,
			title: "Makeup Air Unit Filter Contract",
			description:
				"Quarterly filter changes on both makeup air units for twelve months.",
			status: "Sent",
			address: client2.address,
			priority: "Low",
			subtotal: 840.0,
			tax_rate: 0.0825,
			tax_amount: 69.3,
			total: 909.3,
			issued_at: daysFromNow(-45),
			sent_at: daysFromNow(-45),
			valid_until: daysFromNow(-15),
			expires_at: daysFromNow(-15),
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Quarterly Filter Service (annual)",
						quantity: 4,
						unit_price: 210.0,
						total: 840.0,
						item_type: "other",
						sort_order: 0,
					},
				],
			},
		},
	});

	// ── INV-0006: open dispute, nothing paid ────────────────────────────────────
	// All three outcomes available: no money is applied, so both void-based paths
	// are still legal.
	const invDisputedUnpaid = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0006",
			client_id: client3.id,
			status: "Disputed",
			issue_date: daysFromNow(-18),
			due_date: daysFromNow(12),
			payment_terms_days: 30,
			issued_at: daysFromNow(-18),
			sent_at: daysFromNow(-18),
			amount_paid: 0.0,
			memo: "Emergency after-hours call — Williams managed properties.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "After-hours Emergency Call",
						quantity: 1,
						unit_price: 275.0,
						total: 275.0,
						item_type: "other",
						sort_order: 0,
					},
					{
						name: "Diagnostic Labor (1.5 hrs)",
						quantity: 1.5,
						unit_price: 210.0,
						total: 315.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
		include: { line_items: { orderBy: { sort_order: "asc" } } },
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "invoice",
			invoice_id: invDisputedUnpaid.id,
			status: "Open",
			reason: "Client says the call was placed at 4:40pm, inside business hours, so the after-hours rate should not apply.",
			contested_line_item_ids: [invDisputedUnpaid.line_items[0]!.id],
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-3),
		},
	});

	// ── INV-0007: open dispute holding a partial payment ────────────────────────
	// amount_paid > 0, so Revise & Resend and Repeal are both disabled with the
	// money reason — voiding would strand the payment on a dead record. Issue
	// Adjustment is the only way through.
	const invDisputedPartial = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0007",
			client_id: client5.id,
			status: "Disputed",
			issue_date: daysFromNow(-26),
			due_date: daysFromNow(4),
			payment_terms_days: 30,
			issued_at: daysFromNow(-26),
			sent_at: daysFromNow(-26),
			amount_paid: 500.0,
			memo: "Common-area RTU repair — Riverside Apartments.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Compressor Contactor 40A",
						quantity: 2,
						unit_price: 96.0,
						total: 192.0,
						item_type: "material",
						inventory_item_id: invContactor.id,
						sort_order: 0,
					},
					{
						name: "Repair Labor (6 hrs)",
						quantity: 6,
						unit_price: 160.0,
						total: 960.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	await db.invoice_payment.create({
		data: {
			invoice_id: invDisputedPartial.id,
			amount: 500.0,
			paid_at: daysFromNow(-19),
			method: "check",
			note: "Partial payment while the labour hours are being disputed.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "invoice",
			invoice_id: invDisputedPartial.id,
			status: "Open",
			reason: "Property manager disputes 6 hours of labour — their on-site log shows the technician there for 3.5.",
			status_at_open: "PartiallyPaid",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-5),
		},
	});

	// ── INV-0008: a PAID invoice under dispute ──────────────────────────────────
	// A client contesting something they already paid for is the most common
	// real dispute, and money leaves Issue Adjustment as the only outcome.
	const invDisputedPaid = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0008",
			client_id: client1.id,
			status: "Disputed",
			issue_date: daysFromNow(-40),
			due_date: daysFromNow(-10),
			payment_terms_days: 30,
			issued_at: daysFromNow(-40),
			sent_at: daysFromNow(-40),
			paid_at: daysFromNow(-33),
			amount_paid: 1298.0,
			memo: "Furnace heat exchanger replacement.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Heat Exchanger Assembly",
						quantity: 1,
						unit_price: 740.0,
						total: 740.0,
						item_type: "equipment",
						sort_order: 0,
					},
					{
						name: "Install Labor (3.5 hrs)",
						quantity: 3.5,
						unit_price: 160.0,
						total: 560.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
		},
	});

	await db.invoice_payment.create({
		data: {
			invoice_id: invDisputedPaid.id,
			amount: 1298.0,
			paid_at: daysFromNow(-33),
			method: "card",
			note: "Paid in full on receipt.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "invoice",
			invoice_id: invDisputedPaid.id,
			status: "Open",
			reason: "Client paid, then found the same exchanger listed cheaper elsewhere and is asking for the difference back.",
			status_at_open: "Paid",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: hrsAgo(20),
		},
	});

	// ── INV-0009 + INV-0010 + INV-0013: an adjusted chain ───────────────────────
	// The original is NEVER edited. Its total, number and tax snapshot stand, and
	// its status was restored to status_at_open once the dispute closed. The
	// corrections hang off it as separate linked documents: one credit and one
	// additional charge, which together prove the chain is summed rather than
	// replaced — syncBilledAmounts walks the whole chain for job profitability.
	//
	// The credit is the fixture that makes the receivables fix visible: its
	// balance_due is NEGATIVE, so it nets against what the client owes instead
	// of being floored to zero and vanishing from every AR figure.
	const invAdjusted = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0009",
			client_id: client2.id,
			status: "Sent",
			issue_date: daysFromNow(-34),
			due_date: daysFromNow(-4),
			payment_terms_days: 30,
			issued_at: daysFromNow(-34),
			sent_at: daysFromNow(-34),
			amount_paid: 0.0,
			memo: "Rooftop unit service — Smith Commercial Bldg 2.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_job_id: job2.id,
						name: "RTU Belt & Bearing Service",
						quantity: 1,
						unit_price: 1450.0,
						total: 1450.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						source_job_id: job2.id,
						name: "Service Labor (5 hrs)",
						quantity: 5,
						unit_price: 190.0,
						total: 950.0,
						item_type: "labor",
						sort_order: 1,
					},
				],
			},
			jobs: { create: { job_id: job2.id, billed_amount: 2400.0 } },
		},
		include: { line_items: { orderBy: { sort_order: "asc" } } },
	});

	// The credit. A negative quantity carries the delta, exactly as
	// ServiceTitan's adjustment invoice works, and the line total agrees with
	// quantity x unit price — a document printing "1 x $400" over a different
	// total reconciles against nothing.
	const invCreditNote = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0010",
			client_id: client2.id,
			status: "Issued",
			issue_date: daysFromNow(-12),
			due_date: daysFromNow(18),
			payment_terms_days: 30,
			issued_at: daysFromNow(-12),
			amount_paid: 0.0,
			memo: "Adjusts INV-0009",
			adjusts_invoice_id: invAdjusted.id,
			// Never auto-pushed: exporting a net-negative document as a
			// QuickBooks credit memo is deliberately out of scope for now.
			qb_sync_status: "not_synced",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_job_id: job2.id,
						name: "Credit: Service Labor overbilled (1.5 hrs)",
						quantity: -1.5,
						unit_price: 190.0,
						total: -285.0,
						item_type: "labor",
						sort_order: 0,
					},
				],
			},
		},
	});

	// The additional charge, against the SAME original — an adjustment chain is
	// not limited to credits, and the net across the chain is what the
	// over-crediting ceiling measures.
	const invExtraCharge = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0013",
			client_id: client2.id,
			status: "Issued",
			issue_date: daysFromNow(-11),
			due_date: daysFromNow(19),
			payment_terms_days: 30,
			issued_at: daysFromNow(-11),
			amount_paid: 0.0,
			memo: "Adjusts INV-0009",
			adjusts_invoice_id: invAdjusted.id,
			qb_sync_status: "not_synced",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						source_job_id: job2.id,
						name: "Replacement bearing found seized on teardown",
						quantity: 1,
						unit_price: 128.0,
						total: 128.0,
						item_type: "material",
						sort_order: 0,
					},
				],
			},
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "invoice",
			invoice_id: invAdjusted.id,
			status: "Resolved",
			reason: "Client's site log shows 3.5 hours on site, not the 5 billed. They are not disputing the service itself.",
			contested_line_item_ids: [invAdjusted.line_items[1]!.id],
			// The original was Sent when contested, so it was restored to Sent —
			// not re-Issued, which would have relocked its tax snapshot at
			// today's date and erased that the client had already received it.
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-14),
			resolution: "IssueAdjustment",
			resolution_note:
				"Site log confirmed. Credited 1.5 hours of labour and separately billed the seized bearing found on teardown.",
			resolved_by_dispatcher_id: dispatcher.id,
			resolved_at: daysFromNow(-12),
			adjustment_invoice_id: invCreditNote.id,
		},
	});

	await db.invoice_note.create({
		data: {
			organization_id: org.id,
			invoice_id: invAdjusted.id,
			content:
				"Adjusted rather than reissued — the client already had this invoice and the tax snapshot has to stay at the service date.",
			creator_dispatcher_id: dispatcher.id,
		},
	});

	// ── INV-0011 → INV-0012: resolved via Revise & Resend ───────────────────────
	// Nothing was paid, so replacement was legal. The original is Void with an
	// auto-filled reason naming its successor; the replacement carries version 2,
	// previous_invoice_id, and the job link — attribution moves wholesale, or the
	// job reads as billed zero.
	const invVoidedOriginal = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0011",
			client_id: client5.id,
			status: "Void",
			issue_date: daysFromNow(-22),
			due_date: daysFromNow(8),
			payment_terms_days: 30,
			issued_at: daysFromNow(-22),
			sent_at: daysFromNow(-22),
			voided_at: daysFromNow(-17),
			void_reason: "Replaced by INV-0012 — dispute resolution",
			amount_paid: 0.0,
			qb_sync_status: "not_synced",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Rooftop Access Hatch Repair",
						quantity: 1,
						unit_price: 480.0,
						total: 480.0,
						item_type: "labor",
						sort_order: 0,
					},
					{
						name: "Wrong Site Trip Charge",
						quantity: 1,
						unit_price: 95.0,
						total: 95.0,
						item_type: "other",
						sort_order: 1,
					},
				],
			},
		},
	});

	const invReplacement = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0012",
			client_id: client5.id,
			status: "Issued",
			issue_date: daysFromNow(-17),
			due_date: daysFromNow(13),
			payment_terms_days: 30,
			issued_at: daysFromNow(-17),
			version: 2,
			previous_invoice_id: invVoidedOriginal.id,
			amount_paid: 0.0,
			memo: "Replaces INV-0011 — trip charge removed.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Rooftop Access Hatch Repair",
						quantity: 1,
						unit_price: 480.0,
						total: 480.0,
						item_type: "labor",
						sort_order: 0,
					},
				],
			},
		},
	});

	await db.document_dispute.create({
		data: {
			organization_id: org.id,
			document_kind: "invoice",
			invoice_id: invVoidedOriginal.id,
			status: "Resolved",
			reason: "Client refuses the trip charge — the wrong-site visit was our dispatch error, not theirs.",
			status_at_open: "Sent",
			opened_by_dispatcher_id: dispatcher.id,
			opened_at: daysFromNow(-19),
			resolution: "ReviseAndResend",
			resolution_note: "Our error. Voided and reissued without the trip charge.",
			resolved_by_dispatcher_id: dispatcher.id,
			resolved_at: daysFromNow(-17),
			replacement_invoice_id: invReplacement.id,
		},
	});

	// ── INV-0014: a refund against a paid invoice (D16) ─────────────────────────
	// Recorded as a NEGATIVE invoice_payment row — same table, same arithmetic,
	// no new model. amount_paid is the signed sum, so the invoice falls back out
	// of Paid on its own. Recording a refund does not move money: the card or
	// bank action happens with the payment provider.
	const invRefunded = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0014",
			client_id: client1.id,
			status: "PartiallyPaid",
			issue_date: daysFromNow(-28),
			due_date: daysFromNow(2),
			payment_terms_days: 30,
			issued_at: daysFromNow(-28),
			sent_at: daysFromNow(-28),
			amount_paid: 240.0,
			memo: "Duct cleaning — two returns quoted, one performed.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Duct Cleaning — Return Trunk",
						quantity: 2,
						unit_price: 220.0,
						total: 440.0,
						item_type: "labor",
						sort_order: 0,
					},
				],
			},
		},
	});

	await db.invoice_payment.create({
		data: {
			invoice_id: invRefunded.id,
			amount: 440.0,
			paid_at: daysFromNow(-27),
			method: "card",
			note: "Paid in full at time of service.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	await db.invoice_payment.create({
		data: {
			// Negative: the API takes the size of the refund and the server
			// applies the sign, so a dispatcher never types a minus.
			invoice_id: invRefunded.id,
			amount: -200.0,
			paid_at: daysFromNow(-9),
			method: "card",
			note: "Refunded one of the two return trunks — only one was cleaned. Card refund processed outside the system.",
			recorded_by_dispatcher_id: dispatcher.id,
		},
	});

	// ── INV-0015: a legacy Disputed invoice with NO dispute row ─────────────────
	// Deliberately stranded, and the only fixture here that is not a happy path.
	//
	// Before this work an invoice reached Disputed through a bare status flag
	// that recorded no reason, no actor and no outcome. This row reproduces that
	// state: the banner cannot render without a document_dispute row, and Open
	// Dispute is gated off because Disputed is not a disputable status — so the
	// invoice has no resolve path at all.
	//
	// 20260906120000_backfill_legacy_disputed_invoices exists to fix exactly
	// this, and it has never run against real data — it applied to a database
	// that had no Disputed invoices, so it inserted nothing. Re-running that
	// migration's INSERT against a seeded database is what finally exercises it:
	// this row should gain one Open dispute, and running it twice should still
	// leave exactly one.
	const invLegacyDisputed = await db.invoice.create({
		data: {
			organization_id: org.id,
			invoice_number: "INV-0015",
			client_id: client3.id,
			status: "Disputed",
			issue_date: daysFromNow(-60),
			due_date: daysFromNow(-30),
			payment_terms_days: 30,
			issued_at: daysFromNow(-60),
			sent_at: daysFromNow(-60),
			amount_paid: 0.0,
			memo: "Flagged Disputed by the old status button — no reason or actor was ever recorded.",
			created_by_dispatcher_id: dispatcher.id,
			line_items: {
				create: [
					{
						name: "Condensate Pump Replacement",
						quantity: 1,
						unit_price: 310.0,
						total: 310.0,
						item_type: "equipment",
						sort_order: 0,
					},
				],
			},
		},
	});

	// ── Origin attribution ──────────────────────────────────────────────────────
	// Every invoice above bills real work and needs the `invoice_job` /
	// `invoice_visit` rows that say so, or the detail page renders no origin and
	// its lines name jobs no join row backs. Written in one place so a new
	// fixture can't skip it.
	const attributeInvoice = async (
		invoiceId: string,
		target: { jobId: string; visitId?: string; traceOnly?: boolean },
		sortOrders?: number[],
	) => {
		await db.invoice_line_item.updateMany({
			where: {
				invoice_id: invoiceId,
				...(sortOrders ? { sort_order: { in: sortOrders } } : {}),
			},
			data: {
				source_job_id: target.jobId,
				source_visit_id: target.visitId ?? null,
			},
		});

		// Summed from the lines, never hand-typed: a typed billed_amount can
		// claim a number the line items contradict.
		const lines = await db.invoice_line_item.findMany({
			where: {
				invoice_id: invoiceId,
				source_job_id: target.jobId,
				source_visit_id: target.visitId ?? null,
			},
			select: { total: true },
		});
		const billed = lines.reduce((sum, l) => sum + Number(l.total), 0);

		if (target.visitId) {
			await db.invoice_visit.create({
				data: {
					invoice_id: invoiceId,
					visit_id: target.visitId,
					billed_amount: billed,
				},
			});
			// The parent job rides along for traceability with no amount:
			// job-direct billing counts only lines with a null source_visit_id.
			await db.invoice_job.create({
				data: {
					invoice_id: invoiceId,
					job_id: target.jobId,
					billed_amount: null,
				},
			});
			return;
		}

		await db.invoice_job.create({
			data: {
				invoice_id: invoiceId,
				job_id: target.jobId,
				// A void document bills nothing. Null says "linked, not
				// billed"; zero would say the work was worth nothing.
				billed_amount: target.traceOnly ? null : billed,
			},
		});
	};

	const williamsCompressor = compressorWork.get("J-0018")!;
	const riversideCompressor = compressorWork.get("J-0014")!;
	const williamsOlderCompressor = compressorWork.get("J-0015")!;
	const andersonCompressor = compressorWork.get("J-0016")!;

	// The dispute set. Each bills the work its lines describe.
	await attributeInvoice(invDisputedUnpaid.id, williamsCompressor);
	await attributeInvoice(invDisputedPartial.id, riversideCompressor);
	await attributeInvoice(invDisputedPaid.id, { jobId: job1.id });
	await attributeInvoice(invLegacyDisputed.id, { jobId: williamsOlderCompressor.jobId });
	await attributeInvoice(invRefunded.id, { jobId: job1.id });

	// The adjustment chain — all three against their root's job, so the chain
	// sums to one job's revenue.
	await attributeInvoice(invCreditNote.id, { jobId: job2.id });
	await attributeInvoice(invExtraCharge.id, { jobId: job2.id });

	// Revise & Resend: attribution moves wholesale to the replacement, and the
	// void original keeps a traceability link so the job page can still show
	// what happened to it.
	await attributeInvoice(invVoidedOriginal.id, {
		jobId: riversideCompressor.jobId,
		traceOnly: true,
	});
	await attributeInvoice(invReplacement.id, { jobId: riversideCompressor.jobId });

	// INV-0004 is the one invoice billing two jobs: its parts allowance moves to
	// a second job, leaving labour and filters on the visit. The only fixture
	// with grouped line items.
	await attributeInvoice(invoice4.id, { jobId: andersonCompressor.jobId }, [2]);
	const visit3Lines = await db.invoice_line_item.findMany({
		where: { invoice_id: invoice4.id, source_visit_id: visit3.id },
		select: { total: true },
	});
	await db.invoice_visit.update({
		where: { invoice_id_visit_id: { invoice_id: invoice4.id, visit_id: visit3.id } },
		data: {
			billed_amount: visit3Lines.reduce((sum, l) => sum + Number(l.total), 0),
		},
	});

	// ── Audit trail ─────────────────────────────────────────────────────────────
	// ChangeHistory is already mounted on both detail pages, so dispute history
	// renders with no new UI — but only if these rows exist. The event_type
	// values must stay in step with disputeService's logActivity calls.
	await db.log.createMany({
		data: [
			{ organization_id: org.id, event_type: "quote.dispute_opened", action: "updated", entity_type: "quote", entity_id: quoteDisputed.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Client says the after-hours surcharge was never discussed.", changes: { status: { old: "Sent", new: "Disputed" } }, timestamp: daysFromNow(-2) },
			{ organization_id: org.id, event_type: "quote.dispute_opened", action: "updated", entity_type: "quote", entity_id: quoteSuperseded.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { status: { old: "Sent", new: "Disputed" } }, timestamp: daysFromNow(-8) },
			{ organization_id: org.id, event_type: "quote.dispute_resolved", action: "updated", entity_type: "quote", entity_id: quoteSuperseded.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Re-scoped labour to 2 hours.", changes: { dispute_resolution: { old: null, new: "ReviseAndResend" }, replacement: { old: null, new: "Q-0005" } }, timestamp: daysFromNow(-6) },
			{ organization_id: org.id, event_type: "quote.dispute_resolved", action: "updated", entity_type: "quote", entity_id: quoteRepealed.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Wrong product for the client's water hardness.", changes: { dispute_resolution: { old: null, new: "Repeal" }, status: { old: "Disputed", new: "Cancelled" } }, timestamp: daysFromNow(-10) },
			{ organization_id: org.id, event_type: "quote.dispute_opened", action: "updated", entity_type: "quote", entity_id: quoteSoldDisputed.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { status: { old: "Approved", new: "Disputed" } }, timestamp: daysFromNow(-1) },
			{ organization_id: org.id, event_type: "invoice.dispute_opened", action: "updated", entity_type: "invoice", entity_id: invDisputedUnpaid.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Call was placed inside business hours.", changes: { status: { old: "Sent", new: "Disputed" } }, timestamp: daysFromNow(-3) },
			{ organization_id: org.id, event_type: "invoice.dispute_opened", action: "updated", entity_type: "invoice", entity_id: invDisputedPartial.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { status: { old: "PartiallyPaid", new: "Disputed" } }, timestamp: daysFromNow(-5) },
			{ organization_id: org.id, event_type: "invoice.dispute_opened", action: "updated", entity_type: "invoice", entity_id: invDisputedPaid.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { status: { old: "Paid", new: "Disputed" } }, timestamp: hrsAgo(20) },
			{ organization_id: org.id, event_type: "invoice.dispute_resolved", action: "updated", entity_type: "invoice", entity_id: invAdjusted.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Site log confirmed 3.5 hours.", changes: { dispute_resolution: { old: null, new: "IssueAdjustment" }, adjustment: { old: null, new: "INV-0010" } }, timestamp: daysFromNow(-12) },
			{ organization_id: org.id, event_type: "invoice.adjustment_created", action: "created", entity_type: "invoice", entity_id: invCreditNote.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { adjusts: { old: null, new: "INV-0009" }, total: { old: null, new: -308.51 } }, timestamp: daysFromNow(-12) },
			{ organization_id: org.id, event_type: "invoice.adjustment_created", action: "created", entity_type: "invoice", entity_id: invExtraCharge.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { adjusts: { old: null, new: "INV-0009" }, total: { old: null, new: 138.56 } }, timestamp: daysFromNow(-11) },
			{ organization_id: org.id, event_type: "invoice.dispute_resolved", action: "updated", entity_type: "invoice", entity_id: invVoidedOriginal.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Wrong-site trip charge was our dispatch error.", changes: { dispute_resolution: { old: null, new: "ReviseAndResend" }, replacement: { old: null, new: "INV-0012" } }, timestamp: daysFromNow(-17) },
			{ organization_id: org.id, event_type: "invoice_payment.refunded", action: "created", entity_type: "invoice", entity_id: invRefunded.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, reason: "Only one of the two return trunks was cleaned.", changes: { amount_paid: { old: 440.0, new: 240.0 }, _invoice_number: { old: null, new: "INV-0014" } }, timestamp: daysFromNow(-9) },
		],
	});

	// ============================================================================
	// Tax post-pass — wire tax_group_id + taxable onto line items and recompute
	// tax_amount / totals / tax_snapshot via the centralized tax engine. Exempt
	// clients (Anderson) get taxable=false and a client_exempt snapshot.
	// ============================================================================
	const exemptClientIds = new Set<string>([client4.id]);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const taxOf = (lis: { id: string; total: any }[], exempt: boolean, dType: any, dValue: any, lockedAt?: Date) => {
		const inputs: LineItemTaxInput[] = lis.map((li) => ({
			id: li.id,
			total_cents: Math.round(Number(li.total) * 100),
			taxable: !exempt,
			tax_group: exempt ? null : taxGroupConfig,
		}));
		return calculateDocumentTax(
			{ line_items: inputs, discount_type: dType ?? null, discount_value: dValue != null ? Number(dValue) : null },
			exempt,
			lockedAt,
		);
	};

	// Quotes
	for (const q of await db.quote.findMany({
		select: { id: true, client_id: true, discount_type: true, discount_value: true, approved_at: true, sent_at: true },
	})) {
		const lis = await db.quote_line_item.findMany({ where: { quote_id: q.id }, select: { id: true, total: true } });
		if (lis.length === 0) continue;
		const exempt = exemptClientIds.has(q.client_id);
		const out = taxOf(lis, exempt, q.discount_type, q.discount_value, q.approved_at ?? q.sent_at ?? undefined);
		for (const li of lis) {
			await db.quote_line_item.update({
				where: { id: li.id },
				data: { taxable: !exempt, tax_group_id: exempt ? null : taxGroup.id, tax_amount: centsToDollars(out.line_item_tax_amounts[li.id] ?? 0) },
			});
		}
		await db.quote.update({
			where: { id: q.id },
			data: {
				subtotal: centsToDollars(out.subtotal_cents),
				discount_amount: centsToDollars(out.discount_cents),
				tax_rate: out.effective_rate,
				tax_amount: centsToDollars(out.total_tax_cents),
				total: centsToDollars(out.total_cents),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tax_snapshot: out.snapshot as any,
			},
		});
	}

	// Jobs (skip recurring containers / cancelled jobs with no line items)
	for (const j of await db.job.findMany({
		select: { id: true, client_id: true, discount_type: true, discount_value: true, actual_total: true, completed_at: true },
	})) {
		const lis = await db.job_line_item.findMany({ where: { job_id: j.id }, select: { id: true, total: true } });
		if (lis.length === 0) continue;
		const exempt = exemptClientIds.has(j.client_id);
		const out = taxOf(lis, exempt, j.discount_type, j.discount_value, j.completed_at ?? undefined);
		for (const li of lis) {
			await db.job_line_item.update({
				where: { id: li.id },
				data: { taxable: !exempt, tax_group_id: exempt ? null : taxGroup.id, tax_amount: centsToDollars(out.line_item_tax_amounts[li.id] ?? 0) },
			});
		}
		await db.job.update({
			where: { id: j.id },
			data: {
				subtotal: centsToDollars(out.subtotal_cents),
				discount_amount: centsToDollars(out.discount_cents),
				tax_rate: out.effective_rate,
				tax_amount: centsToDollars(out.total_tax_cents),
				...(j.actual_total != null
					? { actual_total: centsToDollars(out.total_cents) }
					: { estimated_total: centsToDollars(out.total_cents) }),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tax_snapshot: out.snapshot as any,
			},
		});
	}

	// Job visits (client exemption resolved via the parent job)
	for (const v of await db.job_visit.findMany({
		select: { id: true, discount_type: true, discount_value: true, actual_end_at: true, job: { select: { client_id: true } } },
	})) {
		const lis = await db.job_visit_line_item.findMany({ where: { visit_id: v.id }, select: { id: true, total: true } });
		if (lis.length === 0) continue;
		const exempt = exemptClientIds.has(v.job.client_id);
		const out = taxOf(lis, exempt, v.discount_type, v.discount_value, v.actual_end_at ?? undefined);
		for (const li of lis) {
			await db.job_visit_line_item.update({
				where: { id: li.id },
				data: { taxable: !exempt, tax_group_id: exempt ? null : taxGroup.id, tax_amount: centsToDollars(out.line_item_tax_amounts[li.id] ?? 0) },
			});
		}
		await db.job_visit.update({
			where: { id: v.id },
			data: {
				subtotal: centsToDollars(out.subtotal_cents),
				discount_amount: centsToDollars(out.discount_cents),
				tax_rate: out.effective_rate,
				tax_amount: centsToDollars(out.total_tax_cents),
				total: centsToDollars(out.total_cents),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tax_snapshot: out.snapshot as any,
			},
		});
	}

	// Invoices (recompute totals; clamp amount_paid so paid/partial states stay valid)
	for (const inv of await db.invoice.findMany({
		select: { id: true, client_id: true, discount_type: true, discount_value: true, amount_paid: true, issued_at: true, sent_at: true },
	})) {
		const lis = await db.invoice_line_item.findMany({ where: { invoice_id: inv.id }, select: { id: true, total: true } });
		if (lis.length === 0) continue;
		const exempt = exemptClientIds.has(inv.client_id);
		const out = taxOf(lis, exempt, inv.discount_type, inv.discount_value, inv.sent_at ?? inv.issued_at ?? undefined);
		for (const li of lis) {
			await db.invoice_line_item.update({
				where: { id: li.id },
				data: { taxable: !exempt, tax_group_id: exempt ? null : taxGroup.id, tax_amount: centsToDollars(out.line_item_tax_amounts[li.id] ?? 0) },
			});
		}
		const total = centsToDollars(out.total_cents);
		// The clamp keeps Paid/PartiallyPaid states valid when a recomputed
		// total lands below what was seeded as paid. It must not apply to a
		// credit adjustment: Math.min(0, -308.51) would record a payment of
		// -308.51 on a document nobody paid, and the balance would then compute
		// to zero — erasing exactly the negative balance receivables needs.
		const amountPaid =
			total >= 0 ? Math.min(Number(inv.amount_paid), total) : Number(inv.amount_paid);
		await db.invoice.update({
			where: { id: inv.id },
			data: {
				subtotal: centsToDollars(out.subtotal_cents),
				discount_amount: centsToDollars(out.discount_cents),
				tax_rate: out.effective_rate,
				tax_amount: centsToDollars(out.total_tax_cents),
				total,
				amount_paid: amountPaid,
				balance_due: centsToDollars(Math.round((total - amountPaid) * 100)),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tax_snapshot: out.snapshot as any,
			},
		});
	}

	// ============================================================================
	// Activity Logs — stock / vehicle / inventory feed entries
	// ============================================================================
	await db.log.createMany({
		data: [
			{ organization_id: org.id, event_type: "inventory.created", action: "created", entity_type: "inventory_item", entity_id: invBlower.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { name: { old: null, new: "Blower Motor 1/2 HP 115V" } }, timestamp: hrsAgo(30) },
			{ organization_id: org.id, event_type: "vehicle.eod_completed", action: "updated", entity_type: "vehicle", entity_id: van12.id, actor_type: "technician", actor_id: tech1.id, actor_name: tech1.name, changes: { eod: { old: null, new: "completed" } }, timestamp: hrsAgo(16) },
			{ organization_id: org.id, event_type: "stock.restock_fulfilled", action: "updated", entity_type: "vehicle", entity_id: van8.id, actor_type: "dispatcher", actor_id: dispatcher.id, actor_name: dispatcher.name, changes: { capacitors: { old: 1, new: 3 } }, timestamp: hrsAgo(22) },
			{ organization_id: org.id, event_type: "vehicle.readiness_confirmed", action: "updated", entity_type: "vehicle", entity_id: van8.id, actor_type: "technician", actor_id: tech2.id, actor_name: tech2.name, changes: { ready: { old: false, new: true } }, timestamp: hrsAgo(15) },
		],
	});

	console.log("Seeded successfully:");
	console.log(`  Organization:      ${org.name}`);
	console.log(`  Dispatcher:        ${dispatcher.email} / password123`);
	console.log(
		`  Technicians:       ${tech1.email}, ${tech2.email}, ${tech3.email} / password123`,
	);
	console.log(`  Clients:           5  (with contacts & notes)`);
	console.log(`  Contacts:          6`);
	console.log(
		`  Requests:          5  ConvertedToJob, Quoted, New, Reviewing, Cancelled`,
	);
	console.log(
		`  Quotes:            9  Q-0001 Approved, Q-0002 Draft (discount), Q-0003 Disputed (2/3 lines),`,
	);
	console.log(
		`                        Q-0004→Q-0005 revised chain, Q-0006 repealed, Q-0007 Disputed (work sold),`,
	);
	console.log(
		`                        Q-0008 Rejected w/ reason, Q-0009 Sent but past expires_at`,
	);
	console.log(
		`  Recurring Plans:   2  monthly (Williams) + weekly (Anderson, with weekday rule)`,
	);
	console.log(
		`  Invoice Schedules: 2  on_visit_completion + monthly subscription`,
	);
	console.log(
		`  Projects:          6  Active×2, Planning, Completed, OnHold, Cancelled (P-0006 unassigned manager)`,
	);
	console.log(
		`  Jobs:             13  6 standalone + 7 attached to projects (P-0006 has none)`,
	);
	console.log(
		`  Visits:            8  Completed, OnSite, Scheduled, Completed×2, Scheduled, Driving, Paused`,
	);
	console.log(
		`  Occurrences:       5  skipped, completed×2, planned, generated`,
	);
	console.log(
		`  Invoices:         14  Paid, Draft, Sent, PartiallyPaid, Void + the dispute set:`,
	);
	console.log(
		`                        INV-0006/7/8 Disputed (unpaid / part-paid / PAID),`,
	);
	console.log(
		`                        INV-0009 adjusted ← INV-0010 credit + INV-0013 charge,`,
	);
	console.log(
		`                        INV-0011→INV-0012 replaced, INV-0014 refunded, INV-0015 legacy-stranded`,
	);
	console.log(`  Payments:          6  full (check) + partial (ACH) + 3 dispute-set + 1 REFUND (negative)`);
	console.log(
		`  Disputes:          9  5 Open (INV-0006/7/8, Q-0003, Q-0007) + 4 Resolved`,
	);
	console.log(
		`                        outcomes: ReviseAndResend ×2, IssueAdjustment, Repeal`,
	);
	console.log(
		`  ⚠ INV-0015 has status Disputed with NO dispute row — the pre-feature stranded state.`,
	);
	console.log(
		`    Re-run 20260906120000_backfill_legacy_disputed_invoices' INSERT to exercise the backfill`,
	);
	console.log(
		`    (it has never run against real data); twice should still leave exactly one Open dispute.`,
	);
	console.log(`  Form Drafts:       3  quote, job_visit, invoice`);
	console.log(`  Tax:               2 rates → 1 group "WI Standard" (org default)`);
	console.log(`  Inventory:         10 items w/ alt_ids (refrigerant + contactor below threshold)`);
	console.log(`  Vehicles:          3  (Van 12 → Smith+Park, Van 8 → Rodriguez, Truck 4 spare)`);
	console.log(`  Stock Ledger:      receive/restock/parts_used/transfer/loss/supplier_purchase/EOD`);
	console.log(`  Restock Requests:  4  pending, fulfilled, dismissed, discrepant`);
	console.log(`  EOD Records:       2  (Van 12 w/ shortfall, Van 8 → readiness confirmed)`);
	console.log(`  Adjustments:       2  field_loss + audit`);
	console.log(`  Shifts:            2  (+ lunch breaks, visit time entries)`);
	console.log(`  Notifications:     3  (John Smith)`);
	console.log(`  Inventory Tags:    4  Fast-moving, Electrical, Refrigerant, Controls`);
	console.log(`  Serial Units:      5  Blower Motor — in_warehouse/on_vehicle/consumed/lost/returned`);
	console.log(`  Stock Batches:     3  Refrigerant lots — fresh, near-expiry, recalled (2 consumed pre-recall)`);
	console.log(`  Suppliers:         2  Ferguson + Copeland (Airgas/RefrigCo left as legacy free text)`);
	console.log(`  Vendor Prices:     4  contract vs last-paid, incl. one contract-only item (Igniter)`);
	console.log(
		`  Cost & Pricing:       Compressor — 12mo ledger, 3 priced receipts (1 unattributed),`,
	);
	console.log(
		`                        2 same-month sales @ 545/660 → range band + low/high client`,
	);
	console.log(`  Barcodes:          4  items pre-labeled (rest lazily assigned on first scan)`);
	console.log(
		`  Activity Logs:     41 entries covering all feed event types`,
	);
	console.log(
		`  Reconcile Queue:   4 unmapped names (exact / case-insensitive / code / none) + 1 dismissed`,
	);
	console.log(
		`  Provisional Items: 3  tech_submission, dispatch_quick_add, field_purchase`,
	);
	console.log(
		`  Dispositions:      consume / receive (Van 12) / non_stock on visit 3 + plan 2; 1 voided line`,
	);
	console.log(
		`  Field Purchases:   12 (draft, pre-auth x3, review x3, 2nd sign-off, approved, rejected,`,
	);
	console.log(
		`                        unsettled refund, + Maria) — John Smith is the primary tech`,
	);
	console.log(
		`  Purchase Grants:   3  Smith 750/1200/3000, Rodriguez 200/400/900, Park REVOKED`,
	);
	console.log(
		`  Shop Purchases:    4  POs — Van 12 (filters+contactor), Van 8 (refrigerant), Truck 4 (compressor, capacitor+igniter)`,
	);
	console.log(
		`  Maintenance Records: 9  Van 12 (1 per category — oil/tire/brake/inspection/registration/repair/other), Van 8 (refrigerant, PO), Truck 4 (compressor, PO)`,
	);
}

main()
	.then(() => db.$disconnect())
	.catch(async (e) => {
		console.error(e);
		await db.$disconnect();
		process.exit(1);
	});
