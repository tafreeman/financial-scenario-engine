import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
// Console design system — load order matters:
// 1. Console tokens + IBM Plex fonts (the source of truth)
import "./console-ds/styles.css";
// 2. Bridge: maps Console tokens onto VitePress's own CSS vars
import "./console-bridge.css";
// 3. Site-specific tweaks, written in terms of Console tokens
import "./custom.css";

export default {
  extends: DefaultTheme,
} satisfies Theme;
