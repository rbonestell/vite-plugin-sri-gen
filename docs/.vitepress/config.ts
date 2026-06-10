import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
	defineConfig({
		title: "vite-plugin-sri-gen",
		description:
			"Autogenerate Subresource Integrity (SRI) hashes for your Vite build at build time.",
		base: "/vite-plugin-sri-gen/",
		appearance: "dark",
		cleanUrls: true,
		lastUpdated: true,
		head: [
			["link", { rel: "icon", type: "image/svg+xml", href: "/vite-plugin-sri-gen/bolt.svg" }],
		],
		themeConfig: {
			logo: "/bolt.svg",
			nav: [
				{ text: "Getting Started", link: "/getting-started" },
				{ text: "Learn", link: "/learn/what-is-sri" },
				{ text: "Configure", link: "/configure/options" },
				{ text: "Integrate", link: "/integrate/spa-mpa" },
				{ text: "Troubleshoot", link: "/troubleshoot/limitations" },
			],
			sidebar: [
				{ text: "Getting Started", link: "/getting-started" },
				{
					text: "Learn",
					items: [
						{ text: "What is Subresource Integrity?", link: "/learn/what-is-sri" },
						{ text: "How the Plugin Works", link: "/learn/how-it-works" },
						{ text: "Coverage Strategies", link: "/learn/coverage-strategies" },
					],
				},
				{
					text: "Configure",
					items: [
						{ text: "Options", link: "/configure/options" },
						{ text: "Skipping Resources", link: "/configure/skipping-resources" },
						{ text: "Networking", link: "/configure/networking" },
					],
				},
				{
					text: "Integrate",
					items: [
						{ text: "SPA & MPA", link: "/integrate/spa-mpa" },
						{ text: "SSR, SSG & Prerendering", link: "/integrate/ssr-ssg" },
						{ text: "Backend-Owned HTML (Manifest)", link: "/integrate/backend-manifest" },
						{ text: "Import Map Integrity", link: "/integrate/import-map" },
						{ text: "Runtime Patching", link: "/integrate/runtime-patching" },
					],
				},
				{
					text: "Troubleshoot",
					items: [
						{ text: "Limitations", link: "/troubleshoot/limitations" },
						{ text: "Dev Mode", link: "/troubleshoot/dev-mode" },
						{ text: "FAQ", link: "/troubleshoot/faq" },
					],
				},
			],
			search: { provider: "local" },
			editLink: {
				pattern:
					"https://github.com/rbonestell/vite-plugin-sri-gen/edit/main/docs/:path",
				text: "Suggest changes to this page",
			},
			socialLinks: [
				{ icon: "github", link: "https://github.com/rbonestell/vite-plugin-sri-gen" },
				{ icon: "npm", link: "https://www.npmjs.com/package/vite-plugin-sri-gen" },
			],
			footer: {
				message: "Released under the MIT License.",
				copyright: "Copyright © Bobby Bonestell",
			},
		},
		mermaid: {
			theme: "base",
			themeVariables: {
				primaryColor: "#16132a",
				primaryTextColor: "#e2e0f0",
				primaryBorderColor: "#7c3aed",
				lineColor: "#a78bfa",
				secondaryColor: "#1b1733",
				tertiaryColor: "#0e0c1d",
			},
		},
	})
);
