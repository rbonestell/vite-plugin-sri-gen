// ESLint flat config enforcing style and quality for JS and TS
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
	{
		files: ["**/*.{js,cjs,mjs}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
		},
		rules: {
			// Enforce tabs for indentation
			indent: ["error", "tab", { SwitchCase: 1 }],
			// Prevent mixing spaces and tabs
			"no-mixed-spaces-and-tabs": ["error", "smart-tabs"],
			// Require semicolons
			semi: ["error", "always"],
		},
	},
	// TypeScript (source)
	{
		files: ["src/**/*.{ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				project: false,
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			// Base style
			"no-mixed-spaces-and-tabs": ["error", "smart-tabs"],
			semi: ["error", "always"],
			// TS best practices
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ fixStyle: "separate-type-imports", disallowTypeAnnotations: false }
			],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
			],
		},
	},

	// TypeScript (tests) — relax formatting rules
	{
		files: ["test/**/*.{ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			semi: "off",
			"@typescript-eslint/consistent-type-imports": "off",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
			],
		},
	},
	{
		// Common folders to ignore
		ignores: ["dist/**", "coverage/**", "node_modules/**"],
	},
];
