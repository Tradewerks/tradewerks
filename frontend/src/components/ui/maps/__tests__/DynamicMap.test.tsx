import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { MapViewRequest, StaticMarker } from "../../../../types/location";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maps = vi.hoisted(() => [] as Array<Record<string, any>>);

vi.mock("mapbox-gl", () => {
	class FakeMap {
		opts: unknown;
		fitBounds = vi.fn();
		flyTo = vi.fn();
		resize = vi.fn();
		remove = vi.fn();
		on = vi.fn();
		once = vi.fn();
		getZoom = () => 10;
		isStyleLoaded = () => true;
		getCanvas = () => document.createElement("canvas");
		getSource = () => undefined;
		getLayer = () => undefined;
		constructor(opts: unknown) {
			this.opts = opts;
			maps.push(this as unknown as Record<string, unknown>);
		}
	}
	class FakeMarker {
		setLngLat() {
			return this;
		}
		addTo() {
			return this;
		}
		remove() {}
		getLngLat() {
			return { lat: 0, lng: 0 };
		}
	}
	class FakeBounds {
		pts: unknown[] = [];
		extend(p: unknown) {
			this.pts.push(p);
			return this;
		}
	}
	return {
		default: { Map: FakeMap, Marker: FakeMarker, LngLatBounds: FakeBounds, accessToken: "" },
	};
});
vi.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}));

import DynamicMap, { computeInitialBounds } from "../DynamicMap";

const site: StaticMarker = { id: "site", type: "SITE", coords: { lat: 43.8, lon: -91.2 } };
const office: StaticMarker = {
	id: "org",
	type: "WAREHOUSE",
	coords: { lat: 44.5, lon: -90.1 },
	fitIgnore: true,
};
const MARKERS = [site, office];

function Harness({ req }: { req?: MapViewRequest | null }) {
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div ref={ref}>
			<DynamicMap containerRef={ref} staticMarkers={MARKERS} viewRequest={req} />
		</div>
	);
}

beforeEach(() => {
	maps.length = 0;
});

describe("computeInitialBounds", () => {
	test("ignores fitIgnore markers", () => {
		expect(computeInitialBounds([site, office])).toEqual([
			[-91.2, 43.8],
			[-91.2, 43.8],
		]);
	});

	test("returns null when every marker is fitIgnore", () => {
		expect(computeInitialBounds([office])).toBeNull();
	});
});

describe("DynamicMap fitting and view requests", () => {
	test("initial framing and the first auto-fit leave the office out", () => {
		render(<Harness />);
		const map = maps[0];
		expect((map.opts as { bounds: unknown }).bounds).toEqual([
			[-91.2, 43.8],
			[-91.2, 43.8],
		]);
		const autoFitBounds = map.fitBounds.mock.calls[0][0] as { pts: unknown[] };
		expect(autoFitBounds.pts).toEqual([site.coords]);
	});

	test("a fly-to request moves to the target once per id", () => {
		const { rerender } = render(<Harness />);
		const map = maps[0];
		const req: MapViewRequest = { id: 1, target: { lat: 44.5, lon: -90.1 } };
		rerender(<Harness req={req} />);
		rerender(<Harness req={req} />);
		expect(map.flyTo).toHaveBeenCalledTimes(1);
		expect(map.flyTo).toHaveBeenCalledWith(
			expect.objectContaining({ center: [-90.1, 44.5], duration: 200 }),
		);
	});

	test("a fit request frames fit markers only", () => {
		const { rerender } = render(<Harness />);
		const map = maps[0];
		map.fitBounds.mockClear();
		rerender(<Harness req={{ id: 2, target: "fit" }} />);
		expect(map.fitBounds).toHaveBeenCalledWith(
			[
				[-91.2, 43.8],
				[-91.2, 43.8],
			],
			expect.objectContaining({ duration: 200 }),
		);
	});
});

const tech: StaticMarker = { id: "tech-t1", type: "TECHNICIAN", coords: { lat: 43.6, lon: -91.5 } };

function FitHarness({
	markers,
	autoFit,
}: {
	markers: StaticMarker[];
	autoFit?: "once" | "untilInteraction";
}) {
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div ref={ref}>
			<DynamicMap containerRef={ref} staticMarkers={markers} autoFit={autoFit} />
		</div>
	);
}

describe("DynamicMap autoFit", () => {
	test("untilInteraction refits when an active tech arrives after the first framing", () => {
		const { rerender } = render(<FitHarness markers={[site, office]} autoFit="untilInteraction" />);
		const map = maps[0];
		expect(map.fitBounds).not.toHaveBeenCalled();
		rerender(<FitHarness markers={[site, office, tech]} autoFit="untilInteraction" />);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
		expect(map.fitBounds).toHaveBeenCalledWith(
			[
				[-91.5, 43.6],
				[-91.2, 43.8],
			],
			expect.objectContaining({ padding: 120, maxZoom: 13, duration: 200 }),
		);
	});

	test("untilInteraction stops refitting once the user drags the map", () => {
		const { rerender } = render(<FitHarness markers={[site]} autoFit="untilInteraction" />);
		const map = maps[0];
		const dragStart = map.on.mock.calls.find((c: unknown[]) => c[0] === "dragstart")?.[1];
		expect(dragStart).toBeTypeOf("function");
		dragStart({ originalEvent: new MouseEvent("mousedown") });
		rerender(<FitHarness markers={[site, tech]} autoFit="untilInteraction" />);
		expect(map.fitBounds).not.toHaveBeenCalled();
	});

	test("untilInteraction ignores programmatic moves", () => {
		const { rerender } = render(<FitHarness markers={[site]} autoFit="untilInteraction" />);
		const map = maps[0];
		const dragStart = map.on.mock.calls.find((c: unknown[]) => c[0] === "dragstart")?.[1];
		dragStart({});
		rerender(<FitHarness markers={[site, tech]} autoFit="untilInteraction" />);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
	});

	test("untilInteraction: a fit-key change with only fitIgnore markers does not fit", () => {
		const { rerender } = render(<FitHarness markers={[site, office]} autoFit="untilInteraction" />);
		const map = maps[0];
		expect(() =>
			rerender(<FitHarness markers={[office]} autoFit="untilInteraction" />),
		).not.toThrow();
		expect(map.fitBounds).not.toHaveBeenCalled();
	});

	test("default mode fits once and ignores markers that arrive later", () => {
		const { rerender } = render(<FitHarness markers={[site, office]} />);
		const map = maps[0];
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
		rerender(<FitHarness markers={[site, office, tech]} />);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
	});
});

function ReqHarness({ markers, req }: { markers: StaticMarker[]; req: MapViewRequest | null }) {
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div ref={ref}>
			<DynamicMap
				containerRef={ref}
				staticMarkers={markers}
				autoFit="untilInteraction"
				viewRequest={req}
			/>
		</div>
	);
}

const FIT_REQ: MapViewRequest = { id: 1, target: "fit" };
const LOCATE_REQ: MapViewRequest = { id: 1, target: { lat: 44.5, lon: -90.1 } };

describe("DynamicMap untilInteraction and view requests", () => {
	test("a fit request re-arms following: a later new marker refits", () => {
		const { rerender } = render(<ReqHarness markers={[site]} req={null} />);
		const map = maps[0];
		const dragStart = map.on.mock.calls.find((c: unknown[]) => c[0] === "dragstart")?.[1];
		dragStart({ originalEvent: new MouseEvent("mousedown") });
		rerender(<ReqHarness markers={[site]} req={FIT_REQ} />);
		map.fitBounds.mockClear();
		rerender(<ReqHarness markers={[site, tech]} req={FIT_REQ} />);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
	});

	test("a fit request syncs the fit key: the same marker set does not refit again", () => {
		const { rerender } = render(<ReqHarness markers={[site]} req={null} />);
		const map = maps[0];
		rerender(<ReqHarness markers={[site, tech]} req={FIT_REQ} />);
		map.fitBounds.mockClear();
		rerender(<ReqHarness markers={[site, { ...tech }]} req={FIT_REQ} />);
		expect(map.fitBounds).not.toHaveBeenCalled();
	});

	test("a coordinate request disarms following: a later new marker does not refit", () => {
		const { rerender } = render(<ReqHarness markers={[site]} req={null} />);
		const map = maps[0];
		rerender(<ReqHarness markers={[site]} req={LOCATE_REQ} />);
		rerender(<ReqHarness markers={[site, tech]} req={LOCATE_REQ} />);
		expect(map.fitBounds).not.toHaveBeenCalled();
	});
});
