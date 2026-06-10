import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const SITE_URL = "https://rbonestell.com/vite-plugin-sri-gen/";
const SITE_TITLE = "vite-plugin-sri-gen";
const SITE_DESCRIPTION =
	"Autogenerate Subresource Integrity (SRI) hashes for your Vite build at build time.";
const GITHUB_URL = "https://github.com/rbonestell/vite-plugin-sri-gen";

const AUTHOR = {
	"@type": "Person",
	name: "Bobby Bonestell",
	url: "https://rbonestell.com",
};

export default withMermaid(
	defineConfig({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		base: "/vite-plugin-sri-gen/",
		appearance: "dark",
		cleanUrls: true,
		srcExclude: ["superpowers/**"],
		lastUpdated: true,
		sitemap: {
			// VitePress joins hostname + page path without the base, so include it here
			hostname: SITE_URL,
		},
		transformPageData(pageData) {
			// Per-page canonical + Open Graph tags (og:title/og:description/og:url)
			const pagePath = pageData.relativePath
				.replace(/(^|\/)index\.md$/, "$1")
				.replace(/\.md$/, "");
			const url = SITE_URL + pagePath;
			const title =
				pageData.title && pageData.title !== SITE_TITLE
					? `${pageData.title} | ${SITE_TITLE}`
					: SITE_TITLE;
			pageData.frontmatter.head ??= [];
			pageData.frontmatter.head.push(
				["link", { rel: "canonical", href: url }],
				["meta", { property: "og:url", content: url }],
				["meta", { property: "og:title", content: title }],
				[
					"meta",
					{
						property: "og:description",
						content: pageData.description || SITE_DESCRIPTION,
					},
				],
			);

			// JSON-LD structured data: WebSite + SoftwareApplication on the
			// homepage, TechArticle on every docs page.
			const isHome = pageData.relativePath === "index.md";
			const schemas = isHome
				? [
						{
							"@context": "https://schema.org",
							"@type": "WebSite",
							name: SITE_TITLE,
							url: SITE_URL,
							description: SITE_DESCRIPTION,
						},
						{
							"@context": "https://schema.org",
							"@type": "SoftwareApplication",
							name: SITE_TITLE,
							description: SITE_DESCRIPTION,
							url: SITE_URL,
							image: `${SITE_URL}og.png`,
							applicationCategory: "DeveloperApplication",
							operatingSystem: "Node.js >=18",
							offers: {
								"@type": "Offer",
								price: "0",
								priceCurrency: "USD",
							},
							license: `${GITHUB_URL}/blob/main/LICENSE`,
							author: AUTHOR,
							sameAs: [
								GITHUB_URL,
								"https://www.npmjs.com/package/vite-plugin-sri-gen",
							],
						},
					]
				: [
						{
							"@context": "https://schema.org",
							"@type": "TechArticle",
							headline: pageData.title,
							description:
								pageData.description || SITE_DESCRIPTION,
							url,
							image: `${SITE_URL}og.png`,
							author: AUTHOR,
							isPartOf: {
								"@type": "WebSite",
								name: SITE_TITLE,
								url: SITE_URL,
							},
							...(pageData.lastUpdated
								? {
										dateModified: new Date(
											pageData.lastUpdated,
										).toISOString(),
									}
								: {}),
						},
					];
			for (const schema of schemas) {
				pageData.frontmatter.head.push([
					"script",
					{ type: "application/ld+json" },
					JSON.stringify(schema),
				]);
			}
		},
		head: [
			[
				"link",
				{
					rel: "icon",
					type: "image/png",
					href: "/vite-plugin-sri-gen/icon.png",
				},
			],
			["meta", { property: "og:type", content: "website" }],
			["meta", { property: "og:site_name", content: SITE_TITLE }],
			["meta", { property: "og:locale", content: "en_US" }],
			["meta", { property: "og:image", content: `${SITE_URL}og.png` }],
			["meta", { property: "og:image:width", content: "1280" }],
			["meta", { property: "og:image:height", content: "640" }],
			[
				"meta",
				{
					property: "og:image:alt",
					content: "vite-plugin-sri-gen — SRI hashes at build time",
				},
			],
			["meta", { name: "twitter:card", content: "summary_large_image" }],
			["meta", { name: "twitter:image", content: `${SITE_URL}og.png` }],
			[
				"script",
				{
					"data-goatcounter":
						"https://vite-plugin-sri-gen.goatcounter.com/count",
					async: "",
					src: "//gc.zgo.at/count.js",
				},
			],
		],
		themeConfig: {
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
						{
							text: "What is Subresource Integrity?",
							link: "/learn/what-is-sri",
						},
						{
							text: "How the Plugin Works",
							link: "/learn/how-it-works",
						},
						{
							text: "Coverage Strategies",
							link: "/learn/coverage-strategies",
						},
					],
				},
				{
					text: "Configure",
					items: [
						{ text: "Options", link: "/configure/options" },
						{
							text: "Skipping Resources",
							link: "/configure/skipping-resources",
						},
						{ text: "Networking", link: "/configure/networking" },
					],
				},
				{
					text: "Integrate",
					items: [
						{ text: "SPA & MPA", link: "/integrate/spa-mpa" },
						{
							text: "SSR, SSG & Prerendering",
							link: "/integrate/ssr-ssg",
						},
						{
							text: "Backend-Owned HTML (Manifest)",
							link: "/integrate/backend-manifest",
						},
						{
							text: "Import Map Integrity",
							link: "/integrate/import-map",
						},
						{
							text: "Runtime Patching",
							link: "/integrate/runtime-patching",
						},
					],
				},
				{
					text: "Troubleshoot",
					items: [
						{
							text: "Limitations",
							link: "/troubleshoot/limitations",
						},
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
				{
					icon: "github",
					link: "https://github.com/rbonestell/vite-plugin-sri-gen",
				},
				{
					icon: "npm",
					link: "https://www.npmjs.com/package/vite-plugin-sri-gen",
				},
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
	}),
);
