import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";

// Tests assume a zone west of UTC (schedule labels, day keys). Pin it before any
// worker starts: setting TZ inside a test moves Date math but not Intl formatting,
// which V8 resolves once per process.
if (process.env.VITEST) process.env.TZ = "America/Chicago";

export default defineConfig(({ mode }) => ({
	plugins: [react(), tailwindcss(), svgr()],
	define: {
		"process.env.NODE_ENV": JSON.stringify(mode),
	},
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				changeOrigin: true,
				secure: false,
			},
		},
		host: true,
		port: 5173,
		watch: {
			usePolling: true,
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		css: true,
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		exclude: ["tests/**", "node_modules/**", "dist/**"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/",
				"src/test/",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData",
				"dist/",
			],
		},
	},
}));
