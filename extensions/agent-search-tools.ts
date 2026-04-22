/**
 * Agent Search Tools Extension
 *
 * Adds lightweight tools to reduce context usage when looking things up:
 * - web_search: DuckDuckGo HTML search (no API key)
 * - search_repo: local repo text / filename search
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_WEB_RESULTS = 8;
const MAX_REPO_RESULTS = 20;
const WEB_RATE_LIMIT_MS = 1000;

let lastWebSearchAt = 0;

type RepoSearchType = "text" | "filename";

interface WebSearchItem {
	title: string;
	snippet: string;
	url: string;
}

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	max_results: Type.Optional(Type.Number({ description: "Maximum number of results", default: 5 })),
});

const SearchRepoParams = Type.Object({
	query: Type.String({ description: "Text, symbol, or filename to find" }),
	search_type: Type.Optional(
		StringEnum(["text", "filename"] as const, {
			description: "Search text contents or filenames",
			default: "text",
		}),
	),
	path_filter: Type.Optional(Type.String({ description: "Optional path filter, e.g. src or src/components" })),
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ");
}

function normalizePathFilter(pathFilter?: string): string | null {
	if (!pathFilter) return null;
	const cleaned = pathFilter.trim().replace(/^\.\//, "");
	if (!cleaned || cleaned === ".") return null;
	if (cleaned.includes("..") || cleaned.includes("\0")) return null;
	return cleaned;
}

function runCommand(command: string, args: string[]): { ok: boolean; output: string } {
	const proc = spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
	});
	if (proc.status !== 0) {
		return { ok: false, output: (proc.stderr || "").trim() };
	}
	return { ok: true, output: (proc.stdout || "").trim() };
}

function runSearchRepoText(query: string, pathFilter?: string): string {
	const args = ["--line-number", "--max-columns", "200", "--max-count", "3", "--glob", "!node_modules/**", "--", query, "."];
	const filter = normalizePathFilter(pathFilter);
	if (filter) {
		args.splice(args.length - 1, 1, filter);
	}

	const rg = runCommand("rg", args);
	if (!rg.ok || !rg.output) return "No results found.";

	const lines = rg.output.split("\n").slice(0, MAX_REPO_RESULTS);
	return lines.join("\n");
}

function runSearchRepoFilename(query: string, pathFilter?: string): string {
	const filter = normalizePathFilter(pathFilter);
	const findArgs = [".", "-type", "f"];
	if (filter) {
		findArgs.push("-path", `./${filter}/*`);
	}

	const out = runCommand("find", findArgs);
	if (!out.ok || !out.output) return "No results found.";

	const needle = query.toLowerCase();
	const lines = out.output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => line.toLowerCase().includes(needle))
		.slice(0, MAX_REPO_RESULTS);

	if (lines.length === 0) return "No results found.";
	return lines.join("\n");
}

async function performWebSearch(query: string, maxResults: number): Promise<{ ok: boolean; results: WebSearchItem[]; message?: string }> {
	const elapsed = Date.now() - lastWebSearchAt;
	if (elapsed < WEB_RATE_LIMIT_MS) await sleep(WEB_RATE_LIMIT_MS - elapsed);
	lastWebSearchAt = Date.now();

	try {
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
			},
		});
		const html = await res.text();

		const titleMatches = [...html.matchAll(/<a[^>]+class="result__a"[^>]*>(.*?)<\/a>/gms)];
		const snippetMatches = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gms)];
		const urlMatches = [...html.matchAll(/(?:uddg=)(https?[^&"']+)/g)];

		const results = titleMatches.slice(0, maxResults).map((_, i) => ({
			title: stripHtml(titleMatches[i]?.[1] ?? ""),
			snippet: stripHtml(snippetMatches[i]?.[1] ?? ""),
			url: decodeURIComponent(urlMatches[i]?.[1] ?? ""),
		}));

		return { ok: true, results };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, results: [], message };
	}
}

function performRepoSearch(query: string, searchType: RepoSearchType, pathFilter?: string): { ok: boolean; output: string; count: number } {
	const output = searchType === "filename" ? runSearchRepoFilename(query, pathFilter) : runSearchRepoText(query, pathFilter);
	return {
		ok: output !== "No results found.",
		output,
		count: output === "No results found." ? 0 : output.split("\n").filter(Boolean).length,
	};
}

function isLikelyWebQuery(query: string): boolean {
	const q = query.toLowerCase();
	if (/\bhttps?:\/\//.test(q)) return true;
	if (/\b(error|exception|stack trace|docs|documentation|how to|tutorial|guide|why|what is|latest|release notes?)\b/.test(q)) return true;
	return false;
}

function compactLines(text: string, maxLines = 10): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(0, maxLines)
		.join("\n");
}

export default function agentSearchTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using DuckDuckGo HTML. Use for docs, errors, how-tos, and current info.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params) {
			const query = params.query.trim();
			const maxResults = Math.max(1, Math.min(MAX_WEB_RESULTS, Math.floor(params.max_results ?? 5)));
			if (!query) {
				return {
					content: [{ type: "text", text: "[]" }],
					details: { ok: false, message: "Query is empty", query, results: [] },
				};
			}

			const searched = await performWebSearch(query, maxResults);
			const text = JSON.stringify(searched.results, null, 2);
			return {
				content: [{ type: "text", text }],
				details: {
					ok: searched.ok,
					message: searched.message,
					query,
					count: searched.results.length,
					results: searched.results,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("muted", `"${args.query}"`) +
					(args.max_results ? theme.fg("dim", ` max=${args.max_results}`) : ""),
				0,
				0,
			);
		},
		renderResult(result, _context, theme) {
			const details = result.details as { ok?: boolean; count?: number; message?: string } | undefined;
			if (details?.ok) {
				return new Text(theme.fg("success", `✓ ${details.count ?? 0} result(s)`), 0, 0);
			}
			return new Text(theme.fg("warning", `! ${details?.message ?? "No results"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "search_repo",
		label: "Search Repo",
		description: "Search the local codebase for text patterns, filenames, or symbols.",
		parameters: SearchRepoParams,
		async execute(_toolCallId, params) {
			const query = params.query.trim();
			const searchType = (params.search_type ?? "text") as RepoSearchType;
			const pathFilter = params.path_filter?.trim();

			if (!query) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { ok: false, message: "Query is empty", query, searchType },
				};
			}

			const result = performRepoSearch(query, searchType, pathFilter);
			return {
				content: [{ type: "text", text: result.output || "No results found." }],
				details: {
					ok: result.ok,
					query,
					searchType,
					pathFilter: pathFilter || undefined,
					count: result.count,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("search_repo ")) +
					theme.fg("muted", args.search_type ?? "text") +
					" " +
					theme.fg("dim", `"${args.query}"`) +
					(args.path_filter ? theme.fg("dim", ` in ${args.path_filter}`) : ""),
				0,
				0,
			);
		},
		renderResult(result, _context, theme) {
			const details = result.details as { ok?: boolean; count?: number } | undefined;
			if (details?.ok) return new Text(theme.fg("success", `✓ ${details.count ?? 0} match(es)`), 0, 0);
			return new Text(theme.fg("warning", "! No results"), 0, 0);
		},
	});

	pi.registerCommand("search", {
		description: "Smart search helper. Usage: /search [web|text|file] <query>",
		getArgumentCompletions: (prefix) => {
			const options = ["web ", "text ", "file "];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value.trim() })) : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /search [web|text|file] <query>", "warning");
				return;
			}

			const webMatch = raw.match(/^web\s+(.+)$/i);
			const textMatch = raw.match(/^(text|repo)\s+(.+)$/i);
			const fileMatch = raw.match(/^(file|filename)\s+(.+)$/i);

			if (webMatch) {
				const query = webMatch[1].trim();
				const searched = await performWebSearch(query, 5);
				if (!searched.ok) {
					ctx.ui.notify(`Web search failed: ${searched.message ?? "unknown error"}`, "error");
					return;
				}
				if (searched.results.length === 0) {
					ctx.ui.notify("Web search: no results", "warning");
					return;
				}
				const preview = searched.results
					.slice(0, 5)
					.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
					.join("\n");
				ctx.ui.notify(compactLines(`Web results for: ${query}\n${preview}`, 12), "info");
				return;
			}

			if (textMatch || fileMatch) {
				const query = (textMatch?.[2] ?? fileMatch?.[2] ?? "").trim();
				const type: RepoSearchType = fileMatch ? "filename" : "text";
				const result = performRepoSearch(query, type);
				ctx.ui.notify(compactLines(result.output, 14), result.ok ? "info" : "warning");
				return;
			}

			if (isLikelyWebQuery(raw)) {
				const searched = await performWebSearch(raw, 5);
				if (!searched.ok) {
					ctx.ui.notify(`Web search failed: ${searched.message ?? "unknown error"}`, "error");
					return;
				}
				if (searched.results.length === 0) {
					ctx.ui.notify("No web results found.", "warning");
					return;
				}
				const preview = searched.results
					.slice(0, 5)
					.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
					.join("\n");
				ctx.ui.notify(compactLines(`Web results for: ${raw}\n${preview}`, 12), "info");
				return;
			}

			const repoResult = performRepoSearch(raw, "text");
			ctx.ui.notify(compactLines(repoResult.output, 14), repoResult.ok ? "info" : "warning");
		},
	});
}
