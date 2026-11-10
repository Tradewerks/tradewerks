import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { Resource } from "@opentelemetry/resources";
import type { Request, Response, NextFunction } from "express";

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const resource = new Resource({ "service.name": "hvac-backend" });

export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

const readers: PeriodicExportingMetricReader[] = [];

const { GRAFANA_CLOUD_OTLP_ENDPOINT, GRAFANA_CLOUD_OTLP_AUTH } = process.env;

if (GRAFANA_CLOUD_OTLP_ENDPOINT && GRAFANA_CLOUD_OTLP_AUTH) {
	readers.push(
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${GRAFANA_CLOUD_OTLP_ENDPOINT}/v1/metrics`,
				headers: { Authorization: GRAFANA_CLOUD_OTLP_AUTH },
			}),
			exportIntervalMillis: 60_000,
		}),
	);
}

const meterProvider = new MeterProvider({
	resource,
	readers: [prometheusExporter, ...readers],
});

const meter = meterProvider.getMeter("hvac-backend");

export const httpRequestsTotal = meter.createCounter("hvac_http_requests", {
	description: "Total number of HTTP requests",
});

export const httpRequestDuration = meter.createHistogram("hvac_http_request_duration", {
	description: "HTTP request duration in seconds",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	},
});

// ── Agent & assistant ───────────────────────────────────────────────────────
// Exported through the same Prometheus endpoint and Grafana Cloud exporter as
// the HTTP metrics above. The questions these exist to answer: which tools are
// being called, which are failing and why, how long they take, and what the
// model is costing per organization.

export const agentToolCalls = meter.createCounter("hvac_agent_tool_calls", {
	description: "Agent tool calls by tool, surface and outcome",
});

export const agentToolDuration = meter.createHistogram("hvac_agent_tool_duration", {
	description: "Agent tool execution time in seconds",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	},
});

export const assistantTurns = meter.createCounter("hvac_assistant_turns", {
	description: "Assistant turns by surface and outcome",
});

export const assistantTokens = meter.createCounter("hvac_assistant_tokens", {
	description: "Model tokens consumed, by direction and model",
});

export const assistantApprovals = meter.createCounter("hvac_assistant_approvals", {
	description: "Human decisions on gated tool calls",
});

// ── Inventory import drafts ────────────────────────────────────────────────
export const inventoryImportEvents = meter.createCounter("hvac_inventory_import_events", {
	description: "Inventory import lifecycle events",
});

export const inventoryImportDuration = meter.createHistogram("hvac_inventory_import_duration", {
	description: "Time from upload to ready or commit",
	unit: "s",
});

export const inventoryImportMappingDecisions = meter.createCounter("hvac_inventory_import_mapping_decisions", {
	description: "Accepted versus user-edited import mappings",
});

export const inventoryImportDuplicatesPrevented = meter.createCounter("hvac_inventory_import_duplicates_prevented", {
	description: "Within-import, existing-item, and identical-file duplicates surfaced for review",
});

export const inventoryImportConflicts = meter.createCounter("hvac_inventory_import_conflicts", {
	description: "Commit and undo conflicts",
});

export const inventoryPostImportEdits = meter.createCounter("hvac_inventory_post_import_edits", {
	description: "Inventory item edits within seven days of a committed import",
});

// ── Tax rate lookups ────────────────────────────────────────────────────────
// Spec §5: provider health (alert on > 20% failed over 15 min), cache effectiveness,
// and how many drafts are waiting on a dispatcher's tax review.

export const taxProviderCalls = meter.createCounter("hvac_tax_provider_calls", {
	description: "Tax rate provider calls by outcome",
});

// The exporter adds no unit suffix (see hvac_http_request_duration), so the name carries it.
export const taxProviderLatency = meter.createHistogram("hvac_tax_provider_latency_seconds", {
	description: "Tax rate provider call time in seconds",
	unit: "s",
	advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 3, 5] },
});

export const taxResolutionCacheHits = meter.createCounter("hvac_tax_resolution_cache_hits", {
	description: "Tax address resolutions answered from the cache",
});

export const taxDocumentsNeedsReview = meter.createObservableGauge(
	"hvac_tax_documents_needs_review",
	{ description: "Unlocked documents flagged for tax review, by document type" },
);

// ── Receipt OCR ─────────────────────────────────────────────────────────────
// Provider health (alert on failure ratio > 20% over 15 min, or oldest pending > 5 min),
// read time, and which field cutoffs are noisy. Never label by org, purchase or
// anything read off a receipt: cardinality, and receipts are PII.

export const receiptOcrReads = meter.createCounter("hvac_receipt_ocr_reads", {
	description: "Receipt OCR reads by provider and outcome",
});

export const receiptOcrDuration = meter.createHistogram("hvac_receipt_ocr_duration_seconds", {
	description: "Receipt OCR provider call time in seconds, including any wait for a provider slot",
	unit: "s",
	advice: { explicitBucketBoundaries: [1, 2, 3, 5, 8, 13, 20] },
});

export const receiptOcrFieldFlags = meter.createCounter("hvac_receipt_ocr_field_flags", {
	description: "Header fields a read asked the technician to check, by field and kind",
});

export const receiptOcrPending = meter.createObservableGauge("hvac_receipt_ocr_pending", {
	description: "Field purchases whose receipt read is pending",
});

export const receiptOcrOldestPendingAge = meter.createObservableGauge(
	"hvac_receipt_ocr_oldest_pending_age_seconds",
	{ description: "Age of the oldest pending receipt read in seconds", unit: "s" },
);

export const httpMetricsMiddleware =(req: Request, res: Response, next: NextFunction) => {
	const start = performance.now();
	res.on("finish", () => {
		const route = req.route?.path
			? `${req.baseUrl || ""}${req.route.path}`
			: "unmatched";
		const labels = {
			method: req.method,
			route,
			status_code: String(res.statusCode),
		};
		httpRequestDuration.record((performance.now() - start) / 1000, labels);
		httpRequestsTotal.add(1, labels);
	});
	next();
};
