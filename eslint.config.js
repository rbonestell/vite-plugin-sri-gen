// ESLint flat config enforcing tabs for indentation and semicolons at end of statements
// Applies to JS files in this repo. Adjust or extend for TS if needed later.
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
	{
		// Common folders to ignore
		ignores: ["dist/**", "coverage/**", "node_modules/**"],
	},
];
