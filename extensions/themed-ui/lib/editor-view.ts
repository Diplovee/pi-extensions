import path from "node:path";
import type { ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor as PiCustomEditor } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { fitBorder, formatCwd } from "./shared";

class PiChromeEditor extends PiCustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly ctx: ExtensionContext,
    private readonly getModelName: () => string,
    private readonly getThinkingLevel: () => string,
    private readonly getMascot: () => string,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 2) return lines;

    const uiTheme = this.ctx.ui.theme;
    const topLeft = uiTheme.fg("accent", ` ${path.basename(this.ctx.cwd) || this.ctx.cwd} `);
    const isBashMode = this.getText().trimStart().startsWith("!");
    const mascot = this.getMascot();
    const topRight = isBashMode ? `${uiTheme.fg("bashMode", " bash ")} ${mascot} ` : ` ${mascot} `;
    const bottomLeft = uiTheme.fg("muted", ` ${this.getModelName()} · ${this.getThinkingLevel()} `);
    const bottomRight = uiTheme.fg("dim", ` ${formatCwd(this.ctx.cwd)} `);
    const borderColor = (text: string) => this.borderColor(text);

    lines[0] = fitBorder(topLeft, topRight, width, borderColor);
    lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, borderColor);
    return lines;
  }
}

export function installEditor(
  ctx: ExtensionContext,
  getModelName: () => string,
  getThinkingLevel: () => string,
  getMascot: () => string,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) =>
    new PiChromeEditor(tui, theme, keybindings, ctx, getModelName, getThinkingLevel, getMascot),
  );
}
