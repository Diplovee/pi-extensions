/**
 * Agent Search Tools Extension
 *
 * Adds lightweight tools to reduce context usage when looking things up:
 * - web_search: DuckDuckGo HTML search (no API key)
 * - search_repo: local repo text / filename search with max_results and structured match details
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
	max_results: Type.Optional(Type.Number({ description: "Maximum number of results", default: 10 })),
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

interface CommandResult {
	ok: boolean;
	output: string;
	code: number | null;
	message?: string;
}

interface RepoTextMatch {
	file: string;
	line: number | null;
	text: string;
}

interface RepoFilenameMatch {
	path: string;
}

interface RepoSearchResult {
	ok: boolean;
	output: string;
	count: number;
	commandError?: string;
	matches: Array<RepoTextMatch | RepoFilenameMatch>;
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
	const proc = spawnSync(command, args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
	});
	if (proc.error) {
		return { ok: false, output: "", code: null, message: proc.error.message };
	}
	if (proc.status !== 0) {
		return { ok: false, output: (proc.stderr || proc.stdout || "").trim(), code: proc.status };
	}
	return { ok: true, output: (proc.stdout || "").trim(), code: proc.status };
}

function parseTextMatches(output: string, limit: number): RepoTextMatch[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const match = line.match(/^(.+?):(\d+):(.*)$/);
			if (!match) return { file: line, line: null, text: "" } satisfies RepoTextMatch;
			return {
				file: match[1],
				line: Number(match[2]),
				text: match[3].trim(),
			} satisfies RepoTextMatch;
		})
		.slice(0, limit);
}

function runSearchRepoText(cwd: string, query: string, pathFilter: string | undefined, maxResults: number): RepoSearchResult {
	const args = ["--line-number", "--max-columns", "200", "--max-count", String(Math.max(1, maxResults)), "--glob", "!node_modules/**", "--", query, "."];
	const filter = normalizePathFilter(pathFilter);
	if (filter) {
		args.splice(args.length - 1, 1, filter);
	}

	const rg = runCommand("rg", args, cwd);
	if (!rg.ok) {
		const message = rg.message || rg.output || "ripgrep search failed";
		const noResults = rg.code === 1;
		return {
			ok: false,
			output: noResults ? "No results found." : `Search command failed: ${message}`,
			count: 0,
			commandError: noResults ? undefined : message,
			matches: [],
		};
	}
	if (!rg.output) return { ok: false, output: "No results found.", count: 0, matches: [] };

	const matches = parseTextMatches(rg.output, maxResults);
	return {
		ok: matches.length > 0,
		output: matches.length > 0 ? matches.map((match) => `${match.file}:${match.line ?? "?"}:${match.text}`).join("\n") : "No results found.",
		count: matches.length,
		matches,
	};
}

function runSearchRepoFilename(cwd: string, query: string, pathFilter: string | undefined, maxResults: number): RepoSearchResult {
	const filter = normalizePathFilter(pathFilter);
	const findArgs = [".", "-type", "f"];
	if (filter) {
		findArgs.push("-path", `./${filter}/*`);
	}

	const out = runCommand("find", findArgs, cwd);
	if (!out.ok) {
		const message = out.message || out.output || "find search failed";
		return {
			ok: false,
			output: `Search command failed: ${message}`,
			count: 0,
			commandError: message,
			matches: [],
		};
	}
	if (!out.output) return { ok: false, output: "No results found.", count: 0, matches: [] };

	const needle = query.toLowerCase();
	const matches = out.output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => line.toLowerCase().includes(needle))
		.slice(0, maxResults)
		.map((path) => ({ path }) satisfies RepoFilenameMatch);

	if (matches.length === 0) return { ok: false, output: "No results found.", count: 0, matches: [] };
	return {
		ok: true,
		output: matches.map((match) => match.path).join("\n"),
		count: matches.length,
		matches,
	};
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

function performRepoSearch(cwd: string, query: string, searchType: RepoSearchType, pathFilter?: string, maxResults = 10): RepoSearchResult {
	const limit = Math.max(1, Math.min(MAX_REPO_RESULTS, Math.floor(maxResults)));
	return searchType === "filename"
		? runSearchRepoFilename(cwd, query, pathFilter, limit)
		: runSearchRepoText(cwd, query, pathFilter, limit);
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query.trim();
			const searchType = (params.search_type ?? "text") as RepoSearchType;
			const pathFilter = params.path_filter?.trim();
			const maxResults = Math.max(1, Math.min(MAX_REPO_RESULTS, Math.floor(params.max_results ?? 10)));

			if (!query) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { ok: false, message: "Query is empty", query, searchType, results: [] },
				};
			}

			const result = performRepoSearch(ctx.cwd, query, searchType, pathFilter, maxResults);
			return {
				content: [{ type: "text", text: result.output || "No results found." }],
				details: {
					ok: result.ok,
					query,
					searchType,
					pathFilter: pathFilter || undefined,
					count: result.count,
					maxResults,
					cwd: ctx.cwd,
					commandError: result.commandError,
					results: result.matches,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("search_repo ")) +
					theme.fg("muted", args.search_type ?? "text") +
					" " +
					theme.fg("dim", `"${args.query}"`) +
					(args.path_filter ? theme.fg("dim", ` in ${args.path_filter}`) : "") +
					(args.max_results ? theme.fg("dim", ` max=${args.max_results}`) : ""),
				0,
				0,
			);
		},
		renderResult(result, _context, theme) {
			const details = result.details as { ok?: boolean; count?: number; commandError?: string } | undefined;
			if (details?.ok) return new Text(theme.fg("success", `✓ ${details.count ?? 0} match(es)`), 0, 0);
			if (details?.commandError) return new Text(theme.fg("error", `! ${details.commandError}`), 0, 0);
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
				const result = performRepoSearch(ctx.cwd, query, type);
				ctx.ui.notify(compactLines(result.output, 14), result.commandError ? "error" : result.ok ? "info" : "warning");
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

			const repoResult = performRepoSearch(ctx.cwd, raw, "text");
			ctx.ui.notify(compactLines(repoResult.output, 14), repoResult.commandError ? "error" : repoResult.ok ? "info" : "warning");
		},
	});
}
