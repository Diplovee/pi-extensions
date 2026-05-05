import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CURATED_THEMES } from "./shared";

export async function chooseTheme(ctx: ExtensionContext): Promise<string | null> {
  const themes = ctx.ui.getAllThemes().map((t) => t.name);
  const available = CURATED_THEMES.filter((name) => themes.includes(name));
  if (available.length === 0) {
    ctx.ui.notify("No curated themes found. Try /reload.", "warning");
    return null;
  }

  const current = ctx.ui.theme.name ?? "dark";
  const labels = available.map((name) => `${name === current ? "●" : "○"} ${name}`);
  const picked = await ctx.ui.select("Choose a pi theme", labels);
  if (!picked) return null;
  const index = labels.indexOf(picked);
  return index >= 0 ? available[index]! : null;
}
