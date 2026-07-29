import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, devices, errors, type BrowserContext, type Page } from "playwright";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MAX_AGE_SECONDS = 300;
const MAX_CACHE_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_TEXT_BYTES = 100_000;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 40_000_000;
const MAX_VIEWPORT_DIMENSION = 4096;
const BURAWUZA_TASK_PATTERN = /\b(burawuza|browser|responsive|mobile|tablet|iphone|pixel|ipad|web app|localhost|dev server)\b/i;
const BURAWUZA_WORKFLOW_GUIDE = `
Burawuza browser workflow:
- Use the browser_* tools for web UI work; do not launch a separate Chromium/browser from the shell.
- browser_navigate starts the headless browser automatically on first use. Keep the same session/profile for the whole task; do not close it between actions.
- For a local project, first inspect package.json, README, AGENTS.md, or project docs for the documented app/dev-server command. Check whether the app is already running; if not, start it with bash in the background, capture logs, and verify the URL responds before browser_navigate. Do not claim the server is ready until verified.
- Select the device before navigation when the task specifies one. Use browser_device for named devices: mobile/phone -> iphone-15 (and pixel-7 when Android behavior matters), tablet -> ipad, desktop -> desktop. If responsive behavior is unspecified, test desktop and iphone-15; use browser_resize only for an exact custom viewport.
- After changing device or viewport, call browser_page_info to verify it. Use browser_screenshot and browser_content to inspect results, browser_console to read console errors or evaluate page state, then interact with browser_click/browser_type/browser_press/browser_scroll as needed.`;
const DEVICE_PRESETS = {
  desktop: "Desktop Chrome",
  "desktop-hidpi": "Desktop Chrome HiDPI",
  "iphone-13": "iPhone 13",
  "iphone-15": "iPhone 15",
  "iphone-15-landscape": "iPhone 15 landscape",
  "pixel-7": "Pixel 7",
  "pixel-7-landscape": "Pixel 7 landscape",
  ipad: "iPad Pro 11",
  "ipad-landscape": "iPad Pro 11 landscape",
} as const;
const DEVICE_NAMES = Object.keys(DEVICE_PRESETS) as Array<keyof typeof DEVICE_PRESETS>;
type DevicePreset = keyof typeof DEVICE_PRESETS;

const dataRoot = process.env.BURAWUZA_DATA_DIR?.trim() || join(homedir(), ".pi", "agent", "burawuza");
const profilesRoot = join(dataRoot, "profiles");
const cacheRoot = join(dataRoot, "cache");
const configuredExecutable = process.env.BURAWUZA_BROWSER_EXECUTABLE?.trim();
const executablePath = configuredExecutable || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const ignoreHTTPSErrors = process.env.BURAWUZA_IGNORE_HTTPS_ERRORS === "1";

let activeProfile = validateProfileName(process.env.BURAWUZA_PROFILE || "default");
let activeDevice = validateDeviceName(process.env.BURAWUZA_DEVICE || "desktop");
let context: BrowserContext | undefined;
let currentPage: Page | undefined;
const lastUrlByProfile = new Map<string, string>();
const MAX_CONSOLE_ENTRIES = 200;
let consoleEntries: ConsoleEntry[] = [];
const watchedPages = new WeakSet<Page>();
let operationQueue: Promise<void> = Promise.resolve();

interface CachedContent {
  url: string;
  mode: "text" | "html";
  content: string;
  storedAt: string;
  title: string;
}

interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  lineNumber?: number;
  columnNumber?: number;
  timestamp: string;
}

function recordConsoleEntry(entry: ConsoleEntry): void {
  consoleEntries.push(entry);
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE_ENTRIES);
}

function validateProfileName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name === "." || name === "..") {
    throw new Error("Profile name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens (max 64 characters)");
  }
  return name;
}

function validateDeviceName(value: string): DevicePreset {
  const name = value.trim() as DevicePreset;
  if (!DEVICE_NAMES.includes(name)) throw new Error(`Unknown Burawuza device ${value}; choose one of: ${DEVICE_NAMES.join(", ")}`);
  return name;
}

function validateNavigationUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("browser_navigate requires a valid http:// or https:// URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Burawuza only navigates to http:// and https:// URLs");
  return url;
}

function isSafePageUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("http://") || value.startsWith("https://");
}

function assertSafePage(page: Page): void {
  if (page.isClosed()) throw new Error("Burawuza page is closed");
  const url = page.url();
  if (!isSafePageUrl(url)) throw new Error(`Burawuza blocked page scheme ${new URL(url).protocol}; only http:// and https:// pages can be inspected`);
}

function truncateResult(value: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= MAX_RESULT_TEXT_BYTES) return { text: value, truncated: false };
  const text = Buffer.from(value, "utf8").subarray(0, MAX_RESULT_TEXT_BYTES).toString("utf8");
  return { text: `${text}\n\n[Burawuza truncated this result at ${MAX_RESULT_TEXT_BYTES} bytes.]`, truncated: true };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Best effort on platforms without POSIX permissions. */ }
}

function profilePath(profile = activeProfile): string {
  ensurePrivateDirectory(profilesRoot);
  const path = join(profilesRoot, validateProfileName(profile));
  ensurePrivateDirectory(path);
  return path;
}

function cacheFile(url: string, mode: "text" | "html", profile = activeProfile): string {
  const key = createHash("sha256").update(`${validateProfileName(profile)}\n${mode}\n${url}`).digest("hex");
  ensurePrivateDirectory(cacheRoot);
  return join(cacheRoot, `${key}.json`);
}

function activePage(): Page | undefined {
  if (currentPage && !currentPage.isClosed()) return currentPage;
  const pages = context?.pages().filter((page) => !page.isClosed()) ?? [];
  currentPage = pages.at(-1);
  return currentPage;
}

async function closeContext(): Promise<void> {
  const closingContext = context;
  context = undefined;
  currentPage = undefined;
  consoleEntries = [];
  if (closingContext) await closingContext.close();
}

async function ensurePage(options: { allowUnsafeExisting?: boolean } = {}): Promise<Page> {
  const existing = activePage();
  if (existing) {
    if (!options.allowUnsafeExisting) assertSafePage(existing);
    return existing;
  }

  if (!context) {
    if (process.getuid?.() === 0) throw new Error("Burawuza refuses to launch Chromium as root; run Pi as a non-root user so Chromium can use its sandbox");
    const profileDirectory = profilePath();
    const device = devices[DEVICE_PRESETS[activeDevice]];
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      executablePath,
      ...(device ?? { viewport: DEFAULT_VIEWPORT }),
      ignoreHTTPSErrors,
    });
    const createdContext = context;
    createdContext.on("close", () => {
      if (context !== createdContext) return;
      context = undefined;
      currentPage = undefined;
    });
    createdContext.on("page", (page) => watchPage(page));
  }

  const createdPage = await context.newPage();
  watchPage(createdPage);
  return createdPage;
}

function enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = operationQueue.then(async () => {
    signal?.throwIfAborted();
    return operation();
  }, async () => {
    signal?.throwIfAborted();
    return operation();
  });
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function watchPage(page: Page): void {
  currentPage = page;
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on("console", (message) => {
    const location = message.location();
    recordConsoleEntry({
      type: message.type(),
      text: message.text(),
      url: location.url || page.url(),
      ...(location.lineNumber >= 0 ? { lineNumber: location.lineNumber } : {}),
      ...(location.columnNumber >= 0 ? { columnNumber: location.columnNumber } : {}),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("pageerror", (error) => {
    recordConsoleEntry({ type: "pageerror", text: error.stack || error.message, url: page.url(), timestamp: new Date().toISOString() });
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || page.isClosed()) return;
    if (isSafePageUrl(page.url())) {
      lastUrlByProfile.set(activeProfile, page.url());
      return;
    }
    if (currentPage === page) currentPage = undefined;
    void page.close().catch(() => undefined);
  });
  page.on("crash", () => {
    if (currentPage === page) currentPage = undefined;
  });
  page.on("close", () => {
    if (currentPage === page) currentPage = undefined;
  });
}

function pageNavigation(page: Page, operation: () => Promise<unknown>): Promise<void> {
  const previousUrl = page.url();
  return operation().catch((error: unknown) => {
    const current = page.isClosed() ? "" : page.url();
    const committed = current !== "" && current !== "about:blank" && current !== previousUrl;
    if (!(error instanceof errors.TimeoutError) || !committed) throw error;
  }).then(() => {
    assertSafePage(page);
  });
}

function textResult(text: string, details?: Record<string, unknown>) {
  const result = truncateResult(text);
  return { content: [{ type: "text" as const, text: result.text }], details: { ...(details ?? {}), ...(result.truncated ? { truncated: true } : {}) } };
}

function readCachedContent(url: string, mode: "text" | "html", maxAgeSeconds: number): CachedContent | undefined {
  const path = cacheFile(url, mode);
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedContent;
    const age = Date.now() - Date.parse(cached.storedAt);
    if (cached.url !== url || cached.mode !== mode || !Number.isFinite(age) || age < 0 || age > maxAgeSeconds * 1000) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

function writeCachedContent(value: CachedContent): void {
  if (Buffer.byteLength(value.content, "utf8") > MAX_CACHE_CONTENT_BYTES) return;
  const path = cacheFile(value.url, value.mode);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function listProfiles(): string[] {
  ensurePrivateDirectory(profilesRoot);
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const browserNavigate = defineTool({
  name: "browser_navigate",
  label: "Open Burawuza",
  description: "Navigate the standalone headless Burawuza browser to a URL. The selected persistent profile keeps login cookies and browser storage across Pi restarts. For local apps, start and verify the app server first using the documented project command.",
  promptSnippet: "browser_navigate – open a URL in standalone headless Burawuza",
  promptGuidelines: ["Use browser_navigate after selecting the requested browser_device and after verifying any local app server is running; browser_navigate starts Burawuza automatically."],
  parameters: Type.Object({ url: Type.String({ description: "The full URL to navigate to" }) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
        const url = validateNavigationUrl(params.url);
      const page = await ensurePage({ allowUnsafeExisting: true });
      await pageNavigation(page, () => page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }));
      const currentUrl = page.url();
      lastUrlByProfile.set(activeProfile, currentUrl);
      return textResult(`Opened **${await page.title()}** in Burawuza (${currentUrl}).`, { title: await page.title(), url: currentUrl, profile: activeProfile });
    }, signal);
  },
});

const browserScreenshot = defineTool({
  name: "browser_screenshot",
  label: "Screenshot Burawuza",
  description: "Capture the current standalone headless Burawuza page as a PNG image.",
  promptSnippet: "browser_screenshot – capture the current Burawuza page",
  parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page instead of the viewport" })) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      const page = await ensurePage();
      assertSafePage(page);
      const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
      const dimensions = params.fullPage ? await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      })) : viewport;
      if (dimensions.width * dimensions.height > MAX_SCREENSHOT_PIXELS) throw new Error(`Screenshot dimensions exceed the ${MAX_SCREENSHOT_PIXELS}-pixel safety limit; use a viewport screenshot or resize the page first`);
      const buffer = await page.screenshot({ type: "png", fullPage: params.fullPage ?? false });
      if (buffer.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`Screenshot exceeds the ${MAX_SCREENSHOT_BYTES}-byte safety limit; use a viewport screenshot or resize the page first`);
      return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" }], details: { url: page.url(), profile: activeProfile, fullPage: params.fullPage ?? false } };
    }, signal);
  },
});

const browserContent = defineTool({
  name: "browser_content",
  label: "Read Burawuza",
  description: "Read text or HTML from the current page. Set cache=true to persist and reuse content for the selected profile; cached results include their age and must be treated as potentially stale.",
  promptSnippet: "browser_content – read text or HTML from Burawuza",
  parameters: Type.Object({
    mode: Type.Optional(StringEnum(["text", "html"] as const)),
    cache: Type.Optional(Type.Boolean({ description: "Read/write a local TTL cache for this URL" })),
    refresh: Type.Optional(Type.Boolean({ description: "Ignore an existing cache entry and fetch live content" })),
    maxAgeSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Maximum cache age when cache=true; defaults to 300" })),
  }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      const page = await ensurePage();
      assertSafePage(page);
      const mode = params.mode ?? "text";
      const useCache = params.cache ?? false;
      const maxAgeSeconds = params.maxAgeSeconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
      if (useCache && !params.refresh) {
        const cached = readCachedContent(page.url(), mode, maxAgeSeconds);
        if (cached) return textResult(cached.content, { url: cached.url, mode, profile: activeProfile, cached: true, storedAt: cached.storedAt, ageSeconds: Math.round((Date.now() - Date.parse(cached.storedAt)) / 1000) });
      }
      const content = mode === "html" ? await page.content() : await page.locator("body").innerText();
      const title = await page.title();
      if (useCache) writeCachedContent({ url: page.url(), mode, content, title, storedAt: new Date().toISOString() });
      return textResult(content, { url: page.url(), mode, profile: activeProfile, cached: false, ...(useCache ? { cachedForSeconds: maxAgeSeconds } : {}) });
    }, signal);
  },
});

function serializeConsoleValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? `${nested}n` : nested, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

const browserConsole = defineTool({
  name: "browser_console",
  label: "Burawuza Console",
  description: "Read captured browser console/page errors, clear the capture, or evaluate a JavaScript expression in the current safe page. Console entries are limited to the latest 200 messages.",
  promptSnippet: "browser_console – read errors or evaluate JavaScript in Burawuza",
  promptGuidelines: ["Use browser_console read to inspect console errors after loading or interacting with a page; use evaluate for focused DOM/state inspection instead of shell-launched browser debugging."],
  parameters: Type.Object({
    action: StringEnum(["read", "clear", "evaluate"] as const),
    expression: Type.Optional(Type.String({ description: "JavaScript expression for action=evaluate" })),
  }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      if (params.action === "clear") {
        consoleEntries = [];
        return textResult("Cleared Burawuza console entries.", { action: "clear" });
      }
      if (params.action === "read") {
        return textResult(JSON.stringify(consoleEntries, null, 2), { action: "read", count: consoleEntries.length, profile: activeProfile, url: currentPage && !currentPage.isClosed() ? currentPage.url() : "" });
      }
      if (!params.expression?.trim()) throw new Error("browser_console evaluate requires a JavaScript expression");
      const page = await ensurePage();
      assertSafePage(page);
      const value = await page.evaluate((source) => (0, eval)(source), params.expression);
      return textResult(serializeConsoleValue(value), { action: "evaluate", profile: activeProfile, url: page.url() });
    }, signal);
  },
});

const browserPageInfo = defineTool({
  name: "browser_page_info",
  label: "Burawuza Page Info",
  description: "Report the current Burawuza URL, title, selected device, profile, and viewport size.",
  promptSnippet: "browser_page_info – inspect the current Burawuza state",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    return enqueue(async () => {
      const page = await ensurePage();
      const viewport = page.viewportSize();
      const device = devices[DEVICE_PRESETS[activeDevice]];
      const details = {
        title: await page.title(),
        url: page.url(),
        profile: activeProfile,
        device: activeDevice,
        viewport,
        deviceScaleFactor: device?.deviceScaleFactor ?? 1,
        isMobile: device?.isMobile ?? false,
        hasTouch: device?.hasTouch ?? false,
        userAgent: await page.evaluate(() => navigator.userAgent),
      };
      return textResult(JSON.stringify(details, null, 2), details);
    }, signal);
  },
});

const browserDevice = defineTool({
  name: "browser_device",
  label: "Set Burawuza Device",
  description: "Select a named responsive device preset. This changes viewport, user-agent, mobile behavior, touch support, and device pixel ratio. Switching devices recreates the page context but retains the persistent profile and reopens the current URL. Choose the preset from the task: mobile/phone=iphone-15, Android=pixel-7, tablet=ipad, desktop=desktop.",
  promptSnippet: "browser_device – select a mobile, tablet, or desktop device preset",
  promptGuidelines: ["Use browser_device before browser_navigate when the task names a device or asks for responsive testing; verify the result with browser_page_info."],
  parameters: Type.Object({ device: StringEnum(DEVICE_NAMES as readonly string[]) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      const requested = validateDeviceName(params.device);
      const current = activePage();
      const currentUrl = current && isSafePageUrl(current.url()) && current.url() !== "about:blank" ? current.url() : lastUrlByProfile.get(activeProfile);
      if (requested === activeDevice && current) {
        const viewport = current.viewportSize();
        return textResult(`Burawuza is already using the ${requested} device preset.`, { device: requested, viewport, profile: activeProfile });
      }
      await closeContext();
      activeDevice = requested;
      const page = await ensurePage();
      if (currentUrl) await pageNavigation(page, () => page.goto(validateNavigationUrl(currentUrl).href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }));
      const descriptor = devices[DEVICE_PRESETS[activeDevice]];
      return textResult(`Switched Burawuza to ${requested}.`, { device: requested, viewport: page.viewportSize(), deviceScaleFactor: descriptor?.deviceScaleFactor ?? 1, isMobile: descriptor?.isMobile ?? false, hasTouch: descriptor?.hasTouch ?? false, profile: activeProfile, url: page.url() });
    }, signal);
  },
});

const browserResize = defineTool({
  name: "browser_resize",
  label: "Resize Burawuza",
  description: "Set the headless Burawuza viewport to any responsive-testing size in pixels.",
  promptSnippet: "browser_resize – resize Burawuza viewport",
  parameters: Type.Object({ width: Type.Number({ minimum: 1, maximum: MAX_VIEWPORT_DIMENSION }), height: Type.Number({ minimum: 1, maximum: MAX_VIEWPORT_DIMENSION }) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      const page = await ensurePage();
      await page.setViewportSize({ width: Math.round(params.width), height: Math.round(params.height) });
      return textResult(`Resized Burawuza viewport to ${Math.round(params.width)}×${Math.round(params.height)}.`, { width: Math.round(params.width), height: Math.round(params.height), profile: activeProfile });
    }, signal);
  },
});

const browserClick = defineTool({
  name: "browser_click",
  label: "Click Burawuza",
  description: "Click an element in Burawuza using a CSS selector.",
  promptSnippet: "browser_click – click a CSS selector in Burawuza",
  parameters: Type.Object({ selector: Type.String() }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => { const page = await ensurePage(); await page.click(params.selector, { timeout: ACTION_TIMEOUT_MS }); assertSafePage(page); return textResult(`Clicked ${params.selector} in Burawuza.`, { selector: params.selector }); }, signal);
  },
});

const browserType = defineTool({
  name: "browser_type",
  label: "Type in Burawuza",
  description: "Reliably fill an input or editable element in Burawuza using a CSS selector. The tool waits for visibility, scrolls the element into view, and falls back to keyboard typing when direct filling is unsupported.",
  promptSnippet: "browser_type – reliably type text into Burawuza",
  parameters: Type.Object({ selector: Type.String(), text: Type.String(), clear: Type.Optional(Type.Boolean()) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      const page = await ensurePage();
      const locator = page.locator(params.selector).first();
      await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      const clear = params.clear ?? true;
      let method = "fill";
      if (clear) {
        try {
          await locator.fill(params.text, { timeout: ACTION_TIMEOUT_MS });
        } catch {
          method = "keyboard-fallback";
          await locator.click({ timeout: ACTION_TIMEOUT_MS });
          await locator.press("Control+A", { timeout: ACTION_TIMEOUT_MS });
          await locator.pressSequentially(params.text, { delay: 10, timeout: ACTION_TIMEOUT_MS });
        }
      } else {
        method = "keyboard-append";
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        await locator.pressSequentially(params.text, { delay: 10, timeout: ACTION_TIMEOUT_MS });
      }
      assertSafePage(page);
      return textResult(`Typed text into ${params.selector} in Burawuza.`, { selector: params.selector, clear, method });
    }, signal);
  },
});

const browserHover = defineTool({
  name: "browser_hover",
  label: "Hover Burawuza",
  description: "Hover an element in Burawuza using a CSS selector.",
  promptSnippet: "browser_hover – hover a CSS selector in Burawuza",
  parameters: Type.Object({ selector: Type.String() }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => { const page = await ensurePage(); await page.hover(params.selector, { timeout: ACTION_TIMEOUT_MS }); assertSafePage(page); return textResult(`Hovered ${params.selector} in Burawuza.`, { selector: params.selector }); }, signal);
  },
});

const browserPress = defineTool({
  name: "browser_press",
  label: "Press Burawuza Key",
  description: "Press a Playwright keyboard key in Burawuza, such as Enter, Tab, Escape, or Control+A.",
  promptSnippet: "browser_press – press a key in Burawuza",
  parameters: Type.Object({ key: Type.String() }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => { const page = await ensurePage(); await page.keyboard.press(params.key); assertSafePage(page); return textResult(`Pressed ${params.key} in Burawuza.`, { key: params.key }); }, signal);
  },
});

const browserScroll = defineTool({
  name: "browser_scroll",
  label: "Scroll Burawuza",
  description: "Scroll the current Burawuza page by pixel deltas. Positive deltaY scrolls down.",
  promptSnippet: "browser_scroll – scroll Burawuza",
  parameters: Type.Object({ deltaY: Type.Number(), deltaX: Type.Optional(Type.Number()) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => { const page = await ensurePage(); const deltaX = params.deltaX ?? 0; await page.mouse.wheel(deltaX, params.deltaY); assertSafePage(page); return textResult(`Scrolled Burawuza by ${deltaX}, ${params.deltaY}.`, { deltaX, deltaY: params.deltaY }); }, signal);
  },
});

const browserZoom = defineTool({
  name: "browser_zoom",
  label: "Zoom Burawuza",
  description: "Set page zoom from 0.25 (25%) to 3 (300%). Use browser_resize for responsive viewport testing.",
  promptSnippet: "browser_zoom – set Burawuza page zoom",
  parameters: Type.Object({ factor: Type.Number({ minimum: 0.25, maximum: 3 }) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => { const page = await ensurePage(); await page.evaluate((factor) => { document.documentElement.style.zoom = String(factor); }, params.factor); return textResult(`Set Burawuza zoom to ${params.factor}×.`, { factor: params.factor }); }, signal);
  },
});

function historyTool(name: string, label: string, action: "back" | "forward" | "reload", description: string) {
  return defineTool({
    name, label, description, promptSnippet: `${name} – ${description}`, parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return enqueue(async () => {
        const page = await ensurePage();
        const operation = action === "back" ? () => page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }) : action === "forward" ? () => page.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }) : () => page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        await pageNavigation(page, operation);
        const currentUrl = page.url();
        lastUrlByProfile.set(activeProfile, currentUrl);
        return textResult(`${label}: **${await page.title()}** (${currentUrl})`, { title: await page.title(), url: currentUrl });
      }, signal);
    },
  });
}

const browserBack = historyTool("browser_back", "Back in Burawuza", "back", "go back in Burawuza history");
const browserForward = historyTool("browser_forward", "Forward in Burawuza", "forward", "go forward in Burawuza history");
const browserReload = historyTool("browser_reload", "Reload Burawuza", "reload", "reload the current Burawuza page");

const browserRecover = defineTool({
  name: "browser_recover",
  label: "Recover Burawuza",
  description: "Restart the headless Burawuza context and reopen the last URL when possible. The persistent profile is retained.",
  promptSnippet: "browser_recover – recover Burawuza while retaining login state",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    return enqueue(async () => {
      const candidateUrl = activePage()?.url();
      const recoverUrl = candidateUrl && isSafePageUrl(candidateUrl) ? candidateUrl : lastUrlByProfile.get(activeProfile);
      await closeContext();
      const page = await ensurePage();
      if (recoverUrl && recoverUrl !== "about:blank") await pageNavigation(page, () => page.goto(validateNavigationUrl(recoverUrl).href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }));
      const currentUrl = page.url();
      lastUrlByProfile.set(activeProfile, currentUrl);
      return textResult(`Recovered Burawuza${currentUrl ? ` at ${currentUrl}` : ""} using profile ${activeProfile}.`, { url: currentUrl, profile: activeProfile });
    }, signal);
  },
});

const browserClose = defineTool({
  name: "browser_close",
  label: "Close Burawuza",
  description: "Close the current headless Burawuza context. The persistent profile and login state remain on disk.",
  promptSnippet: "browser_close – close Burawuza without deleting its profile",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    return enqueue(async () => { await closeContext(); return textResult(`Closed Burawuza. Profile ${activeProfile} was retained.` , { closed: true, profile: activeProfile }); }, signal);
  },
});

const browserProfile = defineTool({
  name: "browser_profile",
  label: "Manage Burawuza Profiles",
  description: "List, switch, or reset named persistent Burawuza profiles. Profiles isolate cookies and login sessions. Reset requires confirm=true and deletes the selected profile.",
  promptSnippet: "browser_profile – list, switch, or reset persistent Burawuza profiles",
  parameters: Type.Object({
    action: StringEnum(["list", "use", "reset"] as const),
    profile: Type.Optional(Type.String({ description: "Profile name; defaults to the active profile for reset" })),
    confirm: Type.Optional(Type.Boolean({ description: "Required when action=reset" })),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return enqueue(async () => {
      if (params.action === "list") return textResult(JSON.stringify({ active: activeProfile, profiles: listProfiles() }, null, 2), { active: activeProfile, profiles: listProfiles() });
      const requested = validateProfileName(params.profile || activeProfile);
      if (params.action === "reset") {
        if (params.confirm !== true) throw new Error("Resetting a Burawuza profile requires confirm=true");
        if (!ctx.hasUI || !await ctx.ui.confirm("Reset Burawuza profile?", `This permanently deletes the ${requested} profile, including saved login state.`)) {
          throw new Error("Profile reset cancelled; an interactive user confirmation is required");
        }
        if (requested === activeProfile) await closeContext();
        rmSync(join(profilesRoot, requested), { recursive: true, force: true });
        return textResult(`Reset Burawuza profile ${requested}.`, { profile: requested, reset: true });
      }
      if (requested !== activeProfile) {
        await closeContext();
        activeProfile = requested;
      }
      profilePath(activeProfile);
      return textResult(`Using Burawuza profile ${activeProfile}. Existing login state for this profile is retained.`, { profile: activeProfile });
    }, signal);
  },
});

const browserCache = defineTool({
  name: "browser_cache",
  label: "Manage Burawuza Cache",
  description: "Clear the optional local page-content cache. Cache entries are profile-scoped and do not replace persistent login storage.",
  promptSnippet: "browser_cache – clear Burawuza page-content cache",
  parameters: Type.Object({ action: StringEnum(["clear", "clear_profile"] as const) }),
  async execute(_toolCallId, params, signal) {
    return enqueue(async () => {
      ensurePrivateDirectory(cacheRoot);
      if (params.action === "clear") {
        for (const entry of readdirSync(cacheRoot)) rmSync(join(cacheRoot, entry), { force: true });
        return textResult("Cleared all Burawuza page-content cache entries.", { action: params.action });
      }
      const profile = validateProfileName(activeProfile);
      for (const entry of readdirSync(cacheRoot)) {
        const path = join(cacheRoot, entry);
        try {
          const cached = JSON.parse(readFileSync(path, "utf8")) as CachedContent;
          if (cached.url && cached.mode && path === cacheFile(cached.url, cached.mode, profile)) rmSync(path, { force: true });
        } catch { /* Ignore malformed or unrelated cache files. */ }
      }
      return textResult(`Cleared Burawuza page-content cache entries for profile ${profile}.`, { action: params.action, profile });
    }, signal);
  },
});

export default function (pi: ExtensionAPI) {
  ensurePrivateDirectory(dataRoot);
  pi.on("before_agent_start", (event) => {
    if (!BURAWUZA_TASK_PATTERN.test(event.prompt)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${BURAWUZA_WORKFLOW_GUIDE}` };
  });
  ensurePrivateDirectory(profilesRoot);
  ensurePrivateDirectory(cacheRoot);
  pi.on("session_shutdown", async () => {
    await enqueue(() => closeContext());
  });
  pi.registerTool(browserNavigate);
  pi.registerTool(browserScreenshot);
  pi.registerTool(browserContent);
  pi.registerTool(browserConsole);
  pi.registerTool(browserPageInfo);
  pi.registerTool(browserDevice);
  pi.registerTool(browserResize);
  pi.registerTool(browserClick);
  pi.registerTool(browserType);
  pi.registerTool(browserHover);
  pi.registerTool(browserPress);
  pi.registerTool(browserScroll);
  pi.registerTool(browserZoom);
  pi.registerTool(browserBack);
  pi.registerTool(browserForward);
  pi.registerTool(browserReload);
  pi.registerTool(browserRecover);
  pi.registerTool(browserClose);
  pi.registerTool(browserProfile);
  pi.registerTool(browserCache);
}
