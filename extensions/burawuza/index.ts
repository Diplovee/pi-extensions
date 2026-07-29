import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
const MAX_MEMORY_PAGES = 50;
const MAX_MEMORY_EVENTS = 100;
const MAX_MEMORY_SUMMARY_CHARS = 1800;
const MAX_MEMORY_READ_CHARS = 16_000;
const MAX_MEMORY_SCREENSHOTS = 8;
const MAX_MEMORY_SCREENSHOT_BYTES = 24 * 1024 * 1024;
const MAX_MEMORY_FILE_BYTES = 256 * 1024;
const MAX_MEMORY_CAPTURE_CHARS = 12_000;
const MAX_MEMORY_CAPTURE_NODES = 2_000;
const MAX_MEMORY_SELECTOR_CHARS = 500;
const PROJECT_MEMORY_RELATIVE_DIR = ".pi/burawuza";
const PROJECT_MEMORY_CLEAR_MARKER = ".pi/burawuza-clear.json";
const MEMORY_LOCK_STALE_MS = 120_000;
const BURAWUZA_TASK_PATTERN = /\b(burawuza|browser|responsive|mobile|tablet|iphone|pixel|ipad|web app|localhost|dev server)\b/i;
const BURAWUZA_WORKFLOW_GUIDE = `
Burawuza browser workflow:
- Use the browser_* tools for web UI work; do not launch a separate Chromium/browser from the shell.
- browser_navigate starts the headless browser automatically on first use. Keep the same session/profile for the whole task; do not close it between actions.
- For a local project, first inspect package.json, README, AGENTS.md, or project docs for the documented app/dev-server command. Check whether the app is already running; if not, start it with bash in the background, capture logs, and verify the URL responds before browser_navigate. Do not claim the server is ready until verified.
- Select the device before navigation when the task specifies one. Use browser_device for named devices: mobile/phone -> iphone-15 (and pixel-7 when Android behavior matters), tablet -> ipad, desktop -> desktop. If responsive behavior is unspecified, test desktop and iphone-15; use browser_resize only for an exact custom viewport.
- Before interacting with a project app, use browser_memory read to load the compact project-local Burawuza knowledge. Treat it as a hint and verify it live.
- After changing device or viewport, call browser_page_info to verify it. Use browser_screenshot and browser_content to inspect results, browser_console to read console errors or evaluate page state, then interact with browser_click/browser_type/browser_press/browser_scroll as needed. Browser actions automatically update the project memory when the UI changes. Use browser_screenshot with remember=true for explicit visual checkpoints and browser_content with remember=true for short stable labels/content; do not save screenshots or previews containing secrets.`;
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
let activeProjectCwd = process.cwd();
let context: BrowserContext | undefined;
let currentPage: Page | undefined;
const lastUrlByProfile = new Map<string, string>();
const MAX_CONSOLE_ENTRIES = 200;
let consoleEntries: ConsoleEntry[] = [];
const watchedPages = new WeakSet<Page>();
let operationQueue: Promise<void> = Promise.resolve();
let memoryWriteQueue: Promise<void> = Promise.resolve();
let memoryGeneration = 0;
const toolMemoryGeneration = new Map<string, number>();
const toolCallStartedAt = new Map<string, number>();

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

interface ProjectPageMemory {
  url: string;
  title: string;
  profile: string;
  device: string;
  viewport: { width: number; height: number } | null;
  contentHash: string;
  summary: string;
  lastSeen: string;
  lastScreenshot?: string;
}

interface ProjectMemory {
  version: 1;
  updatedAt: string;
  pages: Record<string, ProjectPageMemory>;
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
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked Burawuza directory: ${path}`);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked Burawuza directory: ${path}`);
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

function projectMemoryRoot(cwd = activeProjectCwd): string {
  const project = lstatSync(cwd);
  if (project.isSymbolicLink()) throw new Error(`Refusing symlinked project directory: ${cwd}`);
  const piDirectory = join(cwd, ".pi");
  if (existsSync(piDirectory) && lstatSync(piDirectory).isSymbolicLink()) throw new Error(`Refusing symlinked project .pi directory: ${piDirectory}`);
  ensurePrivateDirectory(piDirectory);
  const root = join(piDirectory, "burawuza");
  ensurePrivateDirectory(root);
  return root;
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readBoundedFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > maxBytes) return undefined;
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sanitizePageMemory(value: unknown): ProjectPageMemory | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const page = value as Partial<ProjectPageMemory>;
  if (typeof page.url !== "string" || typeof page.title !== "string" || typeof page.contentHash !== "string" || typeof page.lastSeen !== "string") return undefined;
  return {
    url: safeMemoryUrl(page.url).slice(0, 512),
    title: compactMemoryText(page.title, 200),
    profile: typeof page.profile === "string" ? page.profile.slice(0, 64) : "default",
    device: typeof page.device === "string" ? page.device.slice(0, 64) : "desktop",
    viewport: page.viewport && typeof page.viewport.width === "number" && typeof page.viewport.height === "number" ? { width: page.viewport.width, height: page.viewport.height } : null,
    contentHash: page.contentHash.slice(0, 128),
    summary: compactMemoryText(typeof page.summary === "string" ? page.summary : ""),
    lastSeen: page.lastSeen.slice(0, 64),
    ...(typeof page.lastScreenshot === "string" ? { lastScreenshot: page.lastScreenshot.slice(0, 256) } : {}),
  };
}

function readProjectMemory(cwd = activeProjectCwd): ProjectMemory {
  const path = join(projectMemoryRoot(cwd), "knowledge.json");
  try {
    const contents = readBoundedFile(path, MAX_MEMORY_FILE_BYTES);
    if (!contents) throw new Error("memory file too large or unavailable");
    const parsed = JSON.parse(contents) as Partial<ProjectMemory>;
    if (parsed.version !== 1 || typeof parsed.pages !== "object" || parsed.pages === null) throw new Error("invalid memory");
    const pages = Object.fromEntries(Object.entries(parsed.pages).flatMap(([key, value]) => {
      const page = sanitizePageMemory(value);
      if (!page) return [];
      if (page.lastScreenshot && !existsSync(join(cwd, page.lastScreenshot))) delete page.lastScreenshot;
      return [[key.slice(0, 64), page]];
    }).slice(0, MAX_MEMORY_PAGES));
    return { version: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt.slice(0, 64) : new Date(0).toISOString(), pages };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), pages: {} };
  }
}

function sanitizeLoadedEvent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of ["timestamp", "tool", "profile", "device", "contentHash"]) {
    if (typeof event[key] === "string") sanitized[key] = String(event[key]).slice(0, 256);
  }
  if (typeof event.url === "string") sanitized.url = safeMemoryUrl(event.url);
  if (typeof event.title === "string") sanitized.title = compactMemoryText(event.title, 200);
  if (typeof event.changed === "boolean") sanitized.changed = event.changed;
  if (typeof event.error === "boolean") sanitized.error = event.error;
  if (typeof event.action === "object" && event.action !== null) sanitized.action = memoryAction(event.action);
  if (typeof event.screenshot === "string" && event.screenshot.startsWith(`${PROJECT_MEMORY_RELATIVE_DIR}/screenshots/`)) sanitized.screenshot = event.screenshot.slice(0, 256);
  if (Array.isArray(event.consoleTail)) sanitized.consoleTail = event.consoleTail.slice(-5).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    return [{ type: typeof item.type === "string" ? item.type.slice(0, 40) : "log", text: compactMemoryText(typeof item.text === "string" ? item.text : "", 400), url: typeof item.url === "string" ? safeMemoryUrl(item.url) : "" }];
  });
  return sanitized;
}

function readProjectEvents(cwd = activeProjectCwd): Array<Record<string, unknown>> {
  const path = join(projectMemoryRoot(cwd), "events.jsonl");
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, MAX_MEMORY_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, length, Math.max(0, fstatSync(fd).size - length)); } finally { closeSync(fd); }
    const contents = buffer.toString("utf8");
    return contents.split(/\r?\n/).filter(Boolean).slice(-MAX_MEMORY_EVENTS).flatMap((line) => {
      try {
        const event = sanitizeLoadedEvent(JSON.parse(line));
        return event ? [event] : [];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

function redactMemoryText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token)\s+[A-Za-z0-9._~-]+/gi, "[secret]=[redacted]")
    .replace(/["']?(?:password|passwd|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?id|api[-_ ]?key|authorization|cookie|jwt|private[-_ ]?key|client[-_ ]?id)["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,;\n}\]]+)/gi, "[secret]=[redacted]")
    .replace(/\b(?:sk|pk|key|secret)[_-][A-Za-z0-9_-]{16,}\b/gi, "[secret]=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[opaque]=[redacted]");
}

function compactMemoryText(value: string, maxChars = MAX_MEMORY_SUMMARY_CHARS): string {
  const compact = redactMemoryText(value).replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function pageMemoryKey(url: string): string {
  return createHash("sha256").update(`${activeProfile}\n${activeDevice}\n${url}`).digest("hex").slice(0, 24);
}

async function captureProjectPageMemory(page: Page): Promise<ProjectPageMemory | undefined> {
  if (page.isClosed() || !isSafePageUrl(page.url())) return undefined;
  const fullUrl = page.url();
  const title = await page.title().catch(() => "");
  const captured = await page.evaluate(({ maxChars, maxNodes }) => {
    if (!document.body) return undefined;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let hash = 2166136261;
    let visibleChars = 0;
    let nodes = 0;
    let truncated = false;
    let node: Node | null = walker.nextNode();
    while (node && visibleChars < maxChars && nodes < maxNodes) {
      const parent = node.parentElement;
      const style = parent ? getComputedStyle(parent) : undefined;
      const hidden = !parent || Boolean(parent.closest("script,style,noscript,template")) || !parent.getClientRects().length || style?.visibility === "hidden" || style?.display === "none" || style?.opacity === "0" || style?.filter !== "none";
      if (!hidden) {
        const value = node.textContent ?? "";
        const remaining = maxChars - visibleChars;
        for (const character of value.slice(0, remaining)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
        visibleChars += Math.min(value.length, remaining);
        truncated = truncated || value.length > remaining;
      }
      nodes += 1;
      node = walker.nextNode();
    }
    if (node) truncated = true;
    return { hash: (hash >>> 0).toString(16), visibleChars, truncated };
  }, { maxChars: MAX_MEMORY_CAPTURE_CHARS, maxNodes: MAX_MEMORY_CAPTURE_NODES }).catch(() => undefined);
  if (!captured) return undefined;
  const storedUrl = safeMemoryUrl(fullUrl);
  const contentHash = createHash("sha256").update(`${title}\n${fullUrl}\n${captured.hash}\n${captured.visibleChars}\n${captured.truncated}`).digest("hex");
  return { url: storedUrl, title: compactMemoryText(title, 200), profile: activeProfile, device: activeDevice, viewport: page.viewportSize(), contentHash, summary: "", lastSeen: new Date().toISOString() };
}

function saveProjectScreenshot(cwd: string, data: string): { path: string; removed: string[] } | undefined {
  const screenshotsRoot = join(projectMemoryRoot(cwd), "screenshots");
  ensurePrivateDirectory(screenshotsRoot);
  const buffer = Buffer.from(data, "base64");
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) return undefined;
  const filename = `${Date.now()}-${createHash("sha256").update(buffer).digest("hex").slice(0, 10)}.png`;
  const path = join(screenshotsRoot, filename);
  writeFileSync(path, buffer, { mode: 0o600 });
  const files = readdirSync(screenshotsRoot).filter((entry) => entry.endsWith(".png")).map((entry) => {
    const filePath = join(screenshotsRoot, entry);
    try { return { entry, path: filePath, mtime: statSync(filePath).mtimeMs, size: statSync(filePath).size }; } catch { return undefined; }
  }).filter((entry): entry is { entry: string; path: string; mtime: number; size: number } => Boolean(entry)).sort((left, right) => left.mtime - right.mtime);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const removed: string[] = [];
  while (files.length > MAX_MEMORY_SCREENSHOTS || total > MAX_MEMORY_SCREENSHOT_BYTES) {
    const oldest = files.shift();
    if (!oldest) break;
    total -= oldest.size;
    removed.push(`${PROJECT_MEMORY_RELATIVE_DIR}/screenshots/${oldest.entry}`);
    rmSync(oldest.path, { force: true });
  }
  return { path: `${PROJECT_MEMORY_RELATIVE_DIR}/screenshots/${filename}`, removed };
}

function safeMemoryUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[blocked-url]";
    const pathname = url.pathname.split("/").map((segment) => {
      if (!segment) return "";
      if (segment.length > 64 || /(?:password|passwd|secret|token|session|auth|key)/i.test(segment) || /^[A-Za-z0-9_-]{24,}$/.test(segment)) return "[redacted]";
      return segment.slice(0, 128);
    }).join("/");
    return `${url.origin}${pathname.slice(0, 512)}`;
  } catch {
    return "[invalid-url]";
  }
}

async function withProjectMemoryLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const root = projectMemoryRoot(cwd);
  const lockPath = join(root, ".lock");
  const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerRecord = JSON.stringify({ pid: process.pid, owner });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      closeSync(fd);
      writeFileSync(lockPath, ownerRecord, { encoding: "utf8", mode: 0o600 });
      const heartbeat = setInterval(() => {
        try { if (readFileSync(lockPath, "utf8") === ownerRecord) utimesSync(lockPath, new Date(), new Date()); } catch { /* The stale-lock recovery may have replaced it. */ }
      }, 5_000);
      heartbeat.unref?.();
      try { return await operation(); } finally {
        clearInterval(heartbeat);
        try { if (readFileSync(lockPath, "utf8") === ownerRecord) rmSync(lockPath, { force: true }); } catch { /* The stale-lock recovery may have replaced it. */ }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        const lockStat = statSync(lockPath);
        let lockInfo: { pid?: unknown } = {};
        try { lockInfo = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }; } catch { /* Reclaim an old partially-written lock below. */ }
        let ownerAlive = false;
        if (typeof lockInfo.pid === "number" && lockInfo.pid !== process.pid) {
          try { process.kill(lockInfo.pid, 0); ownerAlive = true; } catch { ownerAlive = false; }
        }
        if (!ownerAlive && Date.now() - lockStat.mtimeMs > MEMORY_LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch { /* The competing writer may have released the lock. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Timed out waiting for Burawuza project memory lock");
}

function memoryAction(input: unknown): Record<string, unknown> {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const action: Record<string, unknown> = {};
  for (const key of ["url", "selector", "device", "mode", "key", "width", "height", "factor", "deltaX", "deltaY"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number") {
      if (key === "url") action[key] = safeMemoryUrl(String(value[key]));
      else if (typeof value[key] === "string") action[key] = redactMemoryText(String(value[key])).slice(0, MAX_MEMORY_SELECTOR_CHARS);
      else action[key] = value[key];
    }
  }
  if (typeof value.remember === "boolean") action.remember = value.remember;
  if (typeof value.text === "string") action.textLength = value.text.length;
  if (typeof value.expression === "string") action.evaluated = true;
  return action;
}

async function recordProjectBrowserEvent(cwd: string, toolName: string, input: unknown, isError: boolean, content: unknown, startedAt = Date.now()): Promise<void> {
  await withProjectMemoryLock(cwd, async () => {
  const clearMarker = readBoundedFile(join(cwd, PROJECT_MEMORY_CLEAR_MARKER), 1_024);
  if (clearMarker) {
    try { if (startedAt <= Number((JSON.parse(clearMarker) as { clearedAt?: unknown }).clearedAt)) return; } catch { /* Ignore malformed markers. */ }
  }
  const root = projectMemoryRoot(cwd);
  const memory = readProjectMemory(cwd);
  const page = activePage();
  const snapshot = page ? await captureProjectPageMemory(page) : undefined;
  let screenshotPath: string | undefined;
  let removedScreenshots: string[] = [];
  let rememberedContent: string | undefined;
  const toolInput = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  if (!isError && toolName === "browser_content" && toolInput.remember === true && Array.isArray(content)) {
    const text = content.find((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
    if (typeof text?.text === "string") rememberedContent = compactMemoryText(text.text, 600);
  }
  if (!isError && toolName === "browser_screenshot" && toolInput.remember === true && Array.isArray(content)) {
    const image = content.find((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "image") as { data?: unknown } | undefined;
    if (typeof image?.data === "string") {
      const saved = saveProjectScreenshot(cwd, image.data);
      screenshotPath = saved?.path;
      removedScreenshots = saved?.removed ?? [];
    }
  }
  let changed = false;
  if (snapshot) {
    const key = pageMemoryKey(snapshot.url);
    const previous = memory.pages[key];
    changed = Boolean(previous && previous.contentHash !== snapshot.contentHash);
    const previousScreenshot = previous?.lastScreenshot && !removedScreenshots.includes(previous.lastScreenshot) ? previous.lastScreenshot : undefined;
    memory.pages[key] = { ...snapshot, summary: rememberedContent ?? previous?.summary ?? snapshot.summary, ...(screenshotPath ? { lastScreenshot: screenshotPath } : previousScreenshot ? { lastScreenshot: previousScreenshot } : {}) };
    const pages = Object.entries(memory.pages).sort(([, left], [, right]) => right.lastSeen.localeCompare(left.lastSeen)).slice(0, MAX_MEMORY_PAGES);
    memory.pages = Object.fromEntries(pages);
  }
  if (removedScreenshots.length > 0) {
    for (const page of Object.values(memory.pages)) if (page.lastScreenshot && removedScreenshots.includes(page.lastScreenshot)) delete page.lastScreenshot;
  }
  const event: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    action: memoryAction(input),
    profile: activeProfile,
    device: activeDevice,
    ...(snapshot ? { url: snapshot.url, title: snapshot.title, viewport: snapshot.viewport, contentHash: snapshot.contentHash, changed } : {}),
    ...(screenshotPath ? { screenshot: screenshotPath } : {}),
    ...(rememberedContent ? { contentPreview: rememberedContent } : {}),
    ...(isError ? { error: true } : {}),
    ...(consoleEntries.length > 0 ? { consoleTail: consoleEntries.slice(-5).map(({ type, url }) => ({ type, url: safeMemoryUrl(url) })) } : {}),
  };
  const eventsPath = join(root, "events.jsonl");
  let events = [...readProjectEvents(cwd), event].filter((entry) => typeof entry.screenshot !== "string" || !removedScreenshots.includes(entry.screenshot as string)).slice(-MAX_MEMORY_EVENTS);
  while (Buffer.byteLength(events.map((entry) => JSON.stringify(entry)).join("\n"), "utf8") > MAX_MEMORY_FILE_BYTES && events.length > 1) events = events.slice(1);
  atomicWrite(eventsPath, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  memory.updatedAt = new Date().toISOString();
  let knowledge = JSON.stringify(memory, null, 2);
  while (Buffer.byteLength(knowledge, "utf8") > MAX_MEMORY_FILE_BYTES && Object.keys(memory.pages).length > 1) {
    const oldestKey = Object.entries(memory.pages).sort(([, left], [, right]) => left.lastSeen.localeCompare(right.lastSeen))[0]?.[0];
    if (!oldestKey) break;
    delete memory.pages[oldestKey];
    knowledge = JSON.stringify(memory, null, 2);
  }
  atomicWrite(join(root, "knowledge.json"), knowledge);
  });
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

function enqueueMemory<T>(operation: () => Promise<T>): Promise<T> {
  const run = memoryWriteQueue.then(operation, operation);
  memoryWriteQueue = run.then(() => undefined, () => undefined);
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
  description: "Capture the current standalone headless Burawuza page as a PNG image. Set remember=true to save this explicit visual checkpoint in the project-local Burawuza memory; screenshots can contain page-visible secrets.",
  promptSnippet: "browser_screenshot – capture the current Burawuza page",
  parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page instead of the viewport" })), remember: Type.Optional(Type.Boolean({ description: "Save this explicit screenshot checkpoint under .pi/burawuza; defaults to false" })) }),
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
      return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" }], details: { url: page.url(), profile: activeProfile, fullPage: params.fullPage ?? false, remember: params.remember ?? false } };
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
    remember: Type.Optional(Type.Boolean({ description: "Save a short redacted content preview in project Burawuza memory; defaults to false" })),
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
      return textResult(content, { url: page.url(), mode, profile: activeProfile, cached: false, remember: params.remember ?? false, ...(useCache ? { cachedForSeconds: maxAgeSeconds } : {}) });
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

const browserMemory = defineTool({
  name: "browser_memory",
  label: "Project Burawuza Memory",
  description: "Read or clear the bounded project-local Burawuza knowledge log at .pi/burawuza. Read it before browser work; it contains compact page summaries, selectors, changes, console tails, and screenshot paths. Live verification is still required.",
  promptSnippet: "browser_memory – read compact project-local Burawuza knowledge",
  parameters: Type.Object({ action: StringEnum(["read", "clear"] as const) }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return enqueue(async () => {
      const root = projectMemoryRoot(ctx.cwd);
      if (params.action === "clear") {
        return enqueueMemory(async () => {
          if (!ctx.hasUI || !await ctx.ui.confirm("Clear Burawuza project memory?", `This deletes ${root}, including saved screenshots.`)) throw new Error("Project memory clear cancelled; an interactive user confirmation is required");
          return withProjectMemoryLock(ctx.cwd, async () => {
            memoryGeneration += 1;
            const clearedAt = Date.now();
            for (const entry of readdirSync(root)) if (entry !== ".lock") rmSync(join(root, entry), { recursive: true, force: true });
            atomicWrite(join(ctx.cwd, PROJECT_MEMORY_CLEAR_MARKER), JSON.stringify({ clearedAt }));
            return textResult(`Cleared project-local Burawuza memory at ${root}.`, { action: "clear", path: root });
          });
        });
      }
      const memory = readProjectMemory(ctx.cwd);
      const events = readProjectEvents(ctx.cwd).slice(-20).map((event) => {
        const compact: Record<string, unknown> = {};
        for (const key of ["timestamp", "tool", "action", "url", "title", "device", "viewport", "changed", "screenshot", "error"]) if (event[key] !== undefined) compact[key] = event[key];
        return compact;
      });
      const pages = Object.values(memory.pages).sort((left, right) => right.lastSeen.localeCompare(left.lastSeen)).slice(0, 12).map((page) => ({
        url: safeMemoryUrl(page.url), title: page.title, profile: page.profile, device: page.device, viewport: page.viewport, summary: compactMemoryText(page.summary, 600), contentHash: page.contentHash, lastSeen: page.lastSeen, ...(page.lastScreenshot ? { screenshot: page.lastScreenshot } : {}),
      }));
      const payloadValue = { path: root, updatedAt: memory.updatedAt, pages, recentEvents: events };
      while (JSON.stringify(payloadValue).length > MAX_MEMORY_READ_CHARS && payloadValue.pages.length > 1) payloadValue.pages.pop();
      while (JSON.stringify(payloadValue).length > MAX_MEMORY_READ_CHARS && payloadValue.recentEvents.length > 1) payloadValue.recentEvents.shift();
      const payload = JSON.stringify(payloadValue, null, 2);
      return textResult(payload, { action: "read", path: root, pageCount: payloadValue.pages.length, eventCount: payloadValue.recentEvents.length });
    }, signal);
  },
});

const MEMORY_TRACKED_TOOLS = new Set([
  "browser_navigate", "browser_screenshot", "browser_content", "browser_console", "browser_page_info", "browser_device", "browser_resize", "browser_click", "browser_type", "browser_hover", "browser_press", "browser_scroll", "browser_zoom", "browser_back", "browser_forward", "browser_reload", "browser_recover",
]);

export default function (pi: ExtensionAPI) {
  ensurePrivateDirectory(dataRoot);
  pi.on("before_agent_start", (event, ctx) => {
    activeProjectCwd = ctx.cwd;
    if (!BURAWUZA_TASK_PATTERN.test(event.prompt)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${BURAWUZA_WORKFLOW_GUIDE}` };
  });
  pi.on("session_start", (_event, ctx) => {
    activeProjectCwd = ctx.cwd;
  });
  pi.on("tool_call", (event) => {
    if (MEMORY_TRACKED_TOOLS.has(event.toolName)) {
      toolMemoryGeneration.set(event.toolCallId, memoryGeneration);
      toolCallStartedAt.set(event.toolCallId, Date.now());
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!MEMORY_TRACKED_TOOLS.has(event.toolName)) return;
    const generation = toolMemoryGeneration.get(event.toolCallId);
    const startedAt = toolCallStartedAt.get(event.toolCallId) ?? Date.now();
    toolMemoryGeneration.delete(event.toolCallId);
    toolCallStartedAt.delete(event.toolCallId);
    if (generation !== undefined && generation !== memoryGeneration) return;
    activeProjectCwd = ctx.cwd;
    await enqueueMemory(() => recordProjectBrowserEvent(ctx.cwd, event.toolName, event.input, event.isError === true, event.content, startedAt)).catch((error: unknown) => {
      console.warn(`[burawuza] project memory update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
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
  pi.registerTool(browserMemory);
}
