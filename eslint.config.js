// ESLint flat config enforcing style and quality for JS and TS
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
	// JavaScript
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
	// TypeScript
	{
		files: ["src/**/*.{ts,tsx}"],
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
			// Enforce tabs for indentation
			indent: ["error", "tab", { SwitchCase: 1 }],
			// Prevent mixing spaces and tabs
			"no-mixed-spaces-and-tabs": ["error", "smart-tabs"],
			// Require semicolons
			semi: ["error", "always"],
			// TS best practices
			"@typescript-eslint/consistent-type-imports": [
				"warn",
				{
					fixStyle: "separate-type-imports",
					disallowTypeAnnotations: false,
				},
			],
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		// Common folders to ignore
		ignores: ["dist/**", "coverage/**", "node_modules/**"],
	},
];
