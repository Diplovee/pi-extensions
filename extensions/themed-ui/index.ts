import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { installEditor } from "./lib/editor-view";
import { installFooter } from "./lib/footer-view";
import { installHeader } from "./lib/header-view";
import { chooseMascot, CURATED_MASCOTS, getMascotValue, randomMascotName } from "./lib/mascots";
import { chooseTheme } from "./lib/theme-picker";
import { CURATED_THEMES } from "./lib/shared";

export default function (pi: ExtensionAPI) {
  let modelName = "no-model";
  let previousThemeName: string | undefined;
  let customHeaderEnabled = true;
  let mascotName = randomMascotName();
  let previousMascotName: string | undefined;

  const installChrome = (ctx: ExtensionContext) => {
    installHeader(ctx, { enabled: customHeaderEnabled, modelName });
    installEditor(ctx, () => modelName, () => pi.getThinkingLevel(), () => getMascotValue(mascotName) ?? "🤖");
    installFooter(ctx);
  };

  const switchTheme = (ctx: ExtensionContext, themeName: string) => {
    const current = ctx.ui.theme.name;
    const result = ctx.ui.setTheme(themeName);
    if (!result.success) {
      ctx.ui.notify(result.error ?? `Failed to switch to ${themeName}`, "error");
      return false;
    }
    if (current && current !== themeName) previousThemeName = current;
    installChrome(ctx);
    ctx.ui.notify(`Theme: ${themeName}`, "success");
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    modelName = ctx.model?.id ?? "no-model";
    installChrome(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (!ctx.hasUI) return;
    modelName = event.model.id;
    installChrome(ctx);
  });

  pi.registerCommand("pi-theme", {
    description: "Choose or set a pi theme",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const name = args.trim();
      if (name) return void switchTheme(ctx, name);
      const picked = await chooseTheme(ctx);
      if (picked) switchTheme(ctx, picked);
    },
  });

  pi.registerCommand("pi-theme-next", {
    description: "Cycle to the next curated pi theme",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const current = ctx.ui.theme.name;
      const names = CURATED_THEMES.filter((name) => ctx.ui.getTheme(name));
      if (names.length === 0) return;
      const index = current ? names.indexOf(current as (typeof CURATED_THEMES)[number]) : -1;
      switchTheme(ctx, names[(index + 1 + names.length) % names.length]!);
    },
  });

  pi.registerCommand("pi-theme-prev", {
    description: "Cycle to the previous curated pi theme",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const current = ctx.ui.theme.name;
      const names = CURATED_THEMES.filter((name) => ctx.ui.getTheme(name));
      if (names.length === 0) return;
      const index = current ? names.indexOf(current as (typeof CURATED_THEMES)[number]) : 0;
      switchTheme(ctx, names[(index - 1 + names.length) % names.length]!);
    },
  });

  pi.registerCommand("pi-theme-back", {
    description: "Switch back to the previous theme",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!previousThemeName) return void ctx.ui.notify("No previous theme recorded yet", "warning");
      switchTheme(ctx, previousThemeName);
    },
  });

  const switchMascot = (ctx: ExtensionContext, nextMascotName: string) => {
    const value = getMascotValue(nextMascotName);
    if (!value) return void ctx.ui.notify(`Unknown mascot: ${nextMascotName}`, "error");
    if (mascotName !== nextMascotName) previousMascotName = mascotName;
    mascotName = nextMascotName;
    installChrome(ctx);
    ctx.ui.notify(`Mascot: ${nextMascotName} ${value}`, "success");
  };

  pi.registerCommand("pi-mascot", {
    description: "Choose or set the input mascot",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const name = args.trim();
      if (name === "random") return void switchMascot(ctx, randomMascotName());
      if (name) return void switchMascot(ctx, name);
      const picked = await chooseMascot(ctx, mascotName);
      if (picked) switchMascot(ctx, picked);
    },
  });

  pi.registerCommand("pi-mascot-next", {
    description: "Cycle to the next mascot",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const names = CURATED_MASCOTS.map((m) => m.name);
      const index = names.indexOf(mascotName as (typeof names)[number]);
      switchMascot(ctx, names[(index + 1 + names.length) % names.length]!);
    },
  });

  pi.registerCommand("pi-mascot-prev", {
    description: "Cycle to the previous mascot",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const names = CURATED_MASCOTS.map((m) => m.name);
      const index = names.indexOf(mascotName as (typeof names)[number]);
      switchMascot(ctx, names[(index - 1 + names.length) % names.length]!);
    },
  });

  pi.registerCommand("pi-mascot-back", {
    description: "Switch back to the previous mascot",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!previousMascotName) return void ctx.ui.notify("No previous mascot recorded yet", "warning");
      switchMascot(ctx, previousMascotName);
    },
  });

  pi.registerCommand("pi-header-default", {
    description: "Restore pi's built-in header",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      customHeaderEnabled = false;
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });

  pi.registerCommand("pi-header-theme", {
    description: "Restore the custom themed header",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      customHeaderEnabled = true;
      installHeader(ctx, { enabled: true, modelName });
      ctx.ui.notify("Custom themed header restored", "success");
    },
  });
}
