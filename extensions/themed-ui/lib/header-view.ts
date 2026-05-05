import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { center } from "./shared";

function logo(theme: ExtensionContext["ui"]["theme"]): string[] {
  const c1 = (s: string) => theme.fg("borderAccent", s);
  const c2 = (s: string) => theme.fg("accent", s);
  const c3 = (s: string) => theme.fg("border", s);

  return [
    c1("██████╗ ██╗"),
    c1("██╔══██╗██║"),
    c2("██████╔╝██║"),
    c2("██╔═══╝ ██║"),
    c3("██║     ██║"),
    c3("╚═╝     ╚═╝"),
  ];
}

export function installHeader(
  ctx: ExtensionContext,
  options: { enabled: boolean; modelName: string },
): void {
  if (!ctx.hasUI || !options.enabled) return;

  ctx.ui.setHeader((_tui, theme) => ({
    render(width: number): string[] {
      const currentTheme = theme.name ?? "dark";
      const projectName = path.basename(ctx.cwd) || ctx.cwd;
      return [
        "",
        ...logo(theme).map((line) => center(line, width)),
        "",
        center(theme.fg("accent", options.modelName), width),
        center(theme.fg("borderAccent", projectName), width),
        center(theme.fg("muted", `${currentTheme} · /pi-theme · /pi-theme-back`), width),
        center(theme.fg("dim", `/pi-theme-next · /pi-theme-prev · /pi-header-default`), width),
      ];
    },
    invalidate() {},
  }));
}
