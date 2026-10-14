import { defineConfig } from "vite";

export default defineConfig({
	test: {
		watch: false,
		setupFiles: ["./test/setup.ts"],
	},
	build: {
		sourcemap: true,
	}
});
