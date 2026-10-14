import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VehicleStockActionRow from "./VehicleStockActionRow";
import type { RestockMode } from "../../api/org";

const setup = (restockMode: RestockMode | undefined, overrides = {}) => {
	const props = {
		restockMode,
		canStock: true,
		canAdjustStock: true,
		canFieldLoss: false,
		hasStockItems: true,
		onFill: vi.fn(),
		onAdjust: vi.fn(),
		onRequestRestock: vi.fn(),
		onScan: vi.fn(),
		...overrides,
	};
	render(<VehicleStockActionRow {...props} />);
	return props;
};

const fill = () => screen.queryByRole("button", { name: /Fill to Standard/ });
const adjust = () => screen.queryByRole("button", { name: "Adjust Stock" });
const request = () => screen.queryByRole("button", { name: "Request Restock" });

describe("VehicleStockActionRow", () => {
	test("self-serve: Fill is primary and shown; no disclosure", () => {
		setup("tech_self_serve");
		expect(fill()).toBeInTheDocument();
		expect(fill()!.className).toMatch(/bg-primary-hover /);
		expect(request()!.className).not.toMatch(/bg-primary-hover /);
		expect(screen.queryByRole("button", { name: /Self-stocking/ })).toBeNull();
	});

	test("dispatch prepared: Request Restock is primary, Adjust stays visible, Fill behind disclosure", () => {
		setup("dispatch_prepared");
		expect(request()!.className).toMatch(/bg-primary-hover /);
		expect(adjust()).toBeInTheDocument();
		expect(fill()).toBeNull();
	});

	test("disclosure toggles and reports aria-expanded", () => {
		setup("dispatch_prepared");
		const toggle = screen.getByRole("button", { name: /Self-stocking actions/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(fill()).toBeInTheDocument();
		const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
		expect(panel).not.toBeNull();
		expect(panel).toContainElement(fill());
		fireEvent.click(screen.getByRole("button", { name: /Hide self-stocking actions/ }));
		expect(fill()).toBeNull();
	});

	test("while the org loads, no mode-specific layout flashes", () => {
		setup(undefined);
		expect(fill()).toBeNull();
		expect(screen.queryByRole("button", { name: /Self-stocking/ })).toBeNull();
		expect(request()).toBeInTheDocument();
	});

	test("permissions, not mode, decide capability", () => {
		setup("tech_self_serve", { canStock: false });
		expect(fill()).toBeNull();
		expect(adjust()).toBeNull();
	});

	test("Request Restock needs stock items to request against", () => {
		setup("dispatch_prepared", { hasStockItems: false });
		expect(request()).toBeNull();
	});
});
