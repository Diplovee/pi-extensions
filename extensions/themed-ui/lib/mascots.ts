import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const CURATED_MASCOTS = [
  { name: "fox", value: "🦊" },
  { name: "snake", value: "🐍" },
  { name: "robot", value: "🤖" },
  { name: "cat", value: "🐈" },
  { name: "raven", value: "🐦" },
  { name: "octopus", value: "🐙" },
  { name: "sparkles", value: "✨" },
  { name: "fire", value: "🔥" },
] as const;

export type MascotName = (typeof CURATED_MASCOTS)[number]["name"];

export function getMascotValue(name: string): string | undefined {
  return CURATED_MASCOTS.find((m) => m.name === name)?.value;
}

export function randomMascotName(): MascotName {
  return CURATED_MASCOTS[Math.floor(Math.random() * CURATED_MASCOTS.length)]!.name;
}

export async function chooseMascot(ctx: ExtensionContext, current: string): Promise<MascotName | null> {
  const labels = CURATED_MASCOTS.map((m) => `${m.name === current ? "●" : "○"} ${m.name} ${m.value}`);
  const picked = await ctx.ui.select("Choose a mascot", labels);
  if (!picked) return null;
  const index = labels.indexOf(picked);
  return index >= 0 ? CURATED_MASCOTS[index]!.name : null;
}
