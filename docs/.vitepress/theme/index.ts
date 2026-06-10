import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./custom.css";

declare global {
	interface Window {
		goatcounter?: { count: (vars?: { path?: string }) => void };
	}
}

export default {
	extends: DefaultTheme,
	enhanceApp({ router }) {
		if (typeof window === "undefined") return;
		// The script's onload handler counts the initial page view;
		// count client-side navigations here.
		router.onAfterRouteChange = () => {
			window.goatcounter?.count({
				path: location.pathname + location.search,
			});
		};
	},
} satisfies Theme;
