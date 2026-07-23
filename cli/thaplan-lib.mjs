import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
	".git",
	".pi",
	".next",
	".turbo",
	"android",
	"build",
	"dist",
	"ios",
	"node_modules",
]);

const CACHE_DIR = path.join(os.homedir(), ".local", "share", "thaplan");
const CACHE_PATH = path.join(CACHE_DIR, "plan-cache.json");

function loadPlanCache() {
	try {
		return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
	} catch {
		return { version: 1, files: {} };
	}
}

function savePlanCache(cache) {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
	} catch {
		// Non-fatal — cache is a performance optimization
	}
}

function findCachedFile(filePath, cache) {
	const entry = cache.files[filePath];
	if (!entry) return null;
	try {
		const mtime = fs.statSync(filePath).mtimeMs;
		if (entry.mtime === mtime) return entry.plan;
	} catch {
		// File no longer exists
	}
	return null;
}

function humanize(value) {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.trim();
}

function normalizePath(value) {
	return value.split(path.sep).join("/");
}

function parseScalar(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
			.filter(Boolean);
	}
	return trimmed;
}

export function parseFrontmatter(markdown) {
	if (!markdown.startsWith("---")) return {};
	const end = markdown.indexOf("\n---", 3);
	if (end === -1) return {};
	const result = {};
	for (const line of markdown.slice(3, end).split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) result[match[1]] = parseScalar(match[2]);
	}
	return result;
}

function isDirectory(candidate) {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function walkForPlanRoots(current, roots, depth, maxDepth) {
	if (depth > maxDepth || !isDirectory(current)) return;
	const normalized = normalizePath(current);
	if (
		normalized.endsWith("/docs/plans") ||
		(path.basename(current) === "plans" && path.basename(path.dirname(current)) === "docs")
	) {
		roots.push(path.resolve(current));
		return;
	}

	let entries;
	try {
		entries = fs.readdirSync(current, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
		walkForPlanRoots(path.join(current, entry.name), roots, depth + 1, maxDepth);
	}
}

export function discoverPlanRoots(root = process.cwd(), options = {}) {
	const resolved = path.resolve(root);
	if (!isDirectory(resolved)) return [];
	const roots = [];
	walkForPlanRoots(resolved, roots, 0, options.maxDepth ?? 8);
	return [...new Set(roots)].sort();
}

function readMetadata(markdownPath) {
	try {
		return parseFrontmatter(fs.readFileSync(markdownPath, "utf8"));
	} catch {
		return {};
	}
}

function firstHeading(markdown) {
	return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export function pairPlanFiles(files, root = process.cwd(), cache = null, seenFiles = null) {
	const pairs = new Map();
	for (const file of files) {
		const resolved = path.resolve(file);
		const extension = path.extname(resolved).toLowerCase();
		if (extension !== ".md" && extension !== ".html") continue;
		const stem = path.basename(resolved, extension);
		const key = `${path.dirname(resolved)}\0${stem}`;
		const current = pairs.get(key) ?? { stem, directory: path.dirname(resolved) };
		current[extension === ".md" ? "markdownPath" : "htmlPath"] = resolved;
		pairs.set(key, current);
		if (seenFiles) seenFiles.add(resolved);
	}

	const updated = [];

	for (const pair of pairs.values()) {
		const markdownPath = pair.markdownPath;

		// Try cache for unchanged markdown files
		let metadata = {};
		let markdown = "";
		let usedCache = false;

		if (markdownPath && cache) {
			const cached = findCachedFile(markdownPath, cache);
			if (cached) {
				metadata = cached.metadata;
				usedCache = true;
			}
		}

		if (!usedCache && markdownPath) {
			metadata = readMetadata(markdownPath);
			try {
				markdown = fs.readFileSync(markdownPath, "utf8");
			} catch {
				markdown = "";
			}
		}

		const stats = [markdownPath, pair.htmlPath]
			.filter(Boolean)
			.map((file) => fs.statSync(file))
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const planRoot = path.dirname(path.dirname(pair.directory));
		const relativeDirectory = normalizePath(path.relative(root, pair.directory));
		const relativeRoot = normalizePath(path.relative(root, planRoot));
		const appPath = relativeRoot === "" ? path.basename(root) : relativeRoot;
		const title = metadata.title || firstHeading(markdown) || humanize(pair.stem);

		const plan = {
			id: normalizePath(path.relative(root, path.join(pair.directory, pair.stem))),
			stem: pair.stem,
			title,
			status: metadata.status || "unspecified",
			tags: Array.isArray(metadata.tags) ? metadata.tags : metadata.tags ? [String(metadata.tags)] : [],
			app: metadata.app || appPath,
			directory: pair.directory,
			relativeDirectory,
			markdownPath,
			htmlPath: pair.htmlPath,
			complete: Boolean(markdownPath && pair.htmlPath),
			updatedAt: stats[0]?.mtimeMs ?? 0,
			createdAt: Math.min(
				...[markdownPath, pair.htmlPath]
					.filter(Boolean)
					.map((file) => fs.statSync(file).birthtimeMs || fs.statSync(file).ctimeMs),
			),
		};

		// Update cache for this markdown file
		if (markdownPath && cache && !usedCache) {
			cache.files[markdownPath] = {
				mtime: stats[0]?.mtimeMs ?? 0,
				plan: { metadata },
			};
		}

		updated.push(plan);
	}

	return updated;
}

export function discoverPlans(roots = [process.cwd()], options = {}) {
	const useCache = options.noCache !== true;
	const cache = useCache ? loadPlanCache() : null;
	const requestedRoots = Array.isArray(roots) ? roots : [roots];
	const seenFiles = cache ? new Set() : null;
	const plans = [];

	for (const root of requestedRoots) {
		const resolvedRoot = path.resolve(root);
		for (const planRoot of discoverPlanRoots(resolvedRoot, options)) {
			let files;
			try {
				files = fs
					.readdirSync(planRoot)
					.filter((file) => /\.(md|html)$/i.test(file))
					.map((file) => path.join(planRoot, file));
			} catch {
				continue;
			}
			plans.push(...pairPlanFiles(files, resolvedRoot, cache, seenFiles));
		}
	}

	// Remove cache entries for files no longer found on disk
	if (cache && seenFiles) {
		for (const key of Object.keys(cache.files)) {
			if (!seenFiles.has(key)) {
				delete cache.files[key];
			}
		}
	}

	const seen = new Set();
	const result = plans.filter((plan) => {
		const key = `${plan.markdownPath ?? ""}\0${plan.htmlPath ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (cache) savePlanCache(cache);

	return result;
}

export function searchPlans(plans, query = "") {
	const needle = String(query).trim().toLowerCase();
	if (!needle) return [...plans];
	return plans.filter((plan) =>
		`${plan.title} ${plan.status} ${plan.app} ${plan.id} ${plan.tags.join(" ")}`.toLowerCase().includes(needle),
	);
}

export function sortPlans(plans, sort = "modified", direction) {
	const normalized = sort === "new" ? "created" : sort === "old" ? "created" : sort;
	const descending = direction ? direction === "desc" : sort !== "old";
	return [...plans].sort((a, b) => {
		let result = 0;
		if (normalized === "title") result = a.title.localeCompare(b.title);
		else if (normalized === "path") result = a.id.localeCompare(b.id);
		else if (normalized === "created") result = a.createdAt - b.createdAt;
		else result = a.updatedAt - b.updatedAt;
		return descending ? -result : result;
	});
}

export function readPlanDetail(plan) {
	return {
		...plan,
		markdown: plan.markdownPath ? fs.readFileSync(plan.markdownPath, "utf8") : "",
		html: plan.htmlPath ? fs.readFileSync(plan.htmlPath, "utf8") : "",
	};
}

export function serializePlan(plan) {
	const { markdownPath, htmlPath, ...safe } = plan;
	return { ...safe, markdownPath, htmlPath };
}

export function updatePlanStatus(plan, newStatus) {
	if (!plan.markdownPath) throw new Error("This plan has no Markdown source to edit");
	const content = fs.readFileSync(plan.markdownPath, "utf8");
	const updated = content.replace(
		/^(status:\s*).*/m,
		(_, prefix) => `${prefix}${newStatus}`,
	);
	if (updated === content) {
		// No status line in frontmatter — insert after opening ---
		const end = content.indexOf("---\n", 3);
		if (end !== -1) {
			const before = content.slice(0, end + 4);
			const after = content.slice(end + 4);
			return writePlanFileAtomic(plan.markdownPath, `${before}status: ${newStatus}\n${after}`);
		}
		throw new Error("Cannot find frontmatter boundary to insert status");
	}
	return writePlanFileAtomic(plan.markdownPath, updated);
}

function writePlanFileAtomic(filePath, content) {
	const temporaryPath = `${filePath}.thaplan-${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporaryPath, filePath);
	return fs.statSync(filePath).mtimeMs;
}
