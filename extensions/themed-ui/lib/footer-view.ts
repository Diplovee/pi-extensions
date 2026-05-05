import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function installFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData) => ({
    render(width: number): string[] {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;

      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          totalInput += entry.message.usage.input;
          totalOutput += entry.message.usage.output;
          totalCacheRead += entry.message.usage.cacheRead;
          totalCacheWrite += entry.message.usage.cacheWrite;
          totalCost += entry.message.usage.cost.total;
        }
      }

      const contextUsage = ctx.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const contextPercentValue = contextUsage?.percent ?? 0;
      const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
      const autoIndicator = " (auto)";
      const contextPercentDisplay =
        contextPercent === "?"
          ? `?/${formatTokens(contextWindow)}${autoIndicator}`
          : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

      let contextPercentStr = contextPercentDisplay;
      if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
      else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);

      const statsParts: string[] = [];
      if (totalInput) statsParts.push(`${theme.fg("accent", "↑")}${theme.fg("muted", formatTokens(totalInput))}`);
      if (totalOutput) statsParts.push(`${theme.fg("borderAccent", "↓")}${theme.fg("muted", formatTokens(totalOutput))}`);
      if (totalCacheRead) statsParts.push(`${theme.fg("success", "R")}${theme.fg("muted", formatTokens(totalCacheRead))}`);
      if (totalCacheWrite) statsParts.push(`${theme.fg("warning", "W")}${theme.fg("muted", formatTokens(totalCacheWrite))}`);

      const usingSubscription = ctx.model && (ctx.modelRegistry as any)?.isUsingOAuth?.(ctx.model);
      if (totalCost || usingSubscription) {
        statsParts.push(`${theme.fg("dim", "$")}${theme.fg("muted", `${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`)}`);
      }
      statsParts.push(contextPercentStr);

      const statsLeft = statsParts.join(theme.fg("dim", "  "));
      const styledStats = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));

      const statuses = Array.from(footerData.getExtensionStatuses().values()).join(" ");
      const lines = ["", styledStats];
      if (statuses) lines.push(truncateToWidth(theme.fg("dim", statuses), width, theme.fg("dim", "...")));
      return lines;
    },
    invalidate() {},
    dispose: footerData.onBranchChange(() => tui.requestRender()),
  }));
}
