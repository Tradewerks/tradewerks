import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRecordOdometer } from "../vehicleMileage.js";

const vehicleFindFirst = vi.fn();
const vehicleUpdate = vi.fn();
const sdb = { vehicle: { findFirst: vehicleFindFirst, update: vehicleUpdate } } as never;

describe("applyRecordOdometer", () => {
	beforeEach(() => vi.clearAllMocks());

	it("skips records without a reading", async () => {
		await applyRecordOdometer(sdb, "v1", { odometer_mi: null, performed_at: new Date("2026-09-23") });
		expect(vehicleFindFirst).not.toHaveBeenCalled();
		expect(vehicleUpdate).not.toHaveBeenCalled();
	});

	it("does not roll back for a backdated record", async () => {
		vehicleFindFirst.mockResolvedValue({ odometer_updated_at: new Date("2026-09-23T15:00:00Z") });
		await applyRecordOdometer(sdb, "v1", { odometer_mi: 36000, performed_at: new Date("2026-03-01") });
		expect(vehicleUpdate).not.toHaveBeenCalled();
	});

	it("applies a same-day reading even after a timestamped drive update", async () => {
		vehicleFindFirst.mockResolvedValue({ odometer_updated_at: new Date("2026-09-23T15:00:00Z") });
		await applyRecordOdometer(sdb, "v1", { odometer_mi: 43800, performed_at: new Date("2026-09-23") });
		expect(vehicleUpdate).toHaveBeenCalledWith({
			where: { id: "v1" },
			data: { current_odometer_mi: 43800, odometer_updated_at: new Date("2026-09-23") },
		});
	});

	it("applies when the odometer was never set", async () => {
		vehicleFindFirst.mockResolvedValue({ odometer_updated_at: null });
		await applyRecordOdometer(sdb, "v1", { odometer_mi: 1000, performed_at: new Date("2020-01-01") });
		expect(vehicleUpdate).toHaveBeenCalled();
	});
});
