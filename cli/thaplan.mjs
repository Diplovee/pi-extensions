#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { fileURLToPath } from "node:url";
import { discoverPlans, readPlanDetail, renderMarkdownToTerminal, searchPlans, serializePlan, sortPlans, updatePlanStatus } from "./thaplan-lib.mjs";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8910;
const DEEPSEEK_MODEL = "opencode/deepseek-v4-flash-free";
const CODEX_VISION_MODEL = "openai-codex/gpt-5.4";

function usage() {
	console.log(`thaplan — plan generation and cross-app plan browser

Usage:
  thaplan                         interactive repository/action picker
  thaplan list [--root PATH] [--search TEXT] [--sort modified|new|old|title|path] [--json] [--no-cache]
  thaplan read PLAN_ID [--root PATH] [--no-cache]
  thaplan serve [--root PATH] [--port PORT] [--search TEXT] [--no-cache]
  thaplan open [PLAN_ID] [--root PATH] [--port PORT] [--no-cache]
  thaplan generate --name SLUG [--root PATH] [--prompt TEXT] [--reference-image PATH]

Roots default to THAPLAN_ROOTS or the current directory. Each root is searched for
nested docs/plans directories. Plans are paired by basename: name.md + name.html.

The plan cache (∼/.local/share/thaplan/plan-cache.json) speeds up repeated scans
by reusing metadata from unchanged files. Use --no-cache to force a full re-scan,
or --clear-cache to delete the cache file.
`);
}

function parseArgs(argv) {
	const positionals = [];
	const options = { roots: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const [key, inlineValue] = arg.slice(2).split("=", 2);
		if (key === "help" || key === "h") {
			options.help = true;
			continue;
		}
		if (key === "json") {
			options.json = true;
			continue;
		}
		if (key === "no-cache") {
			options.noCache = true;
			continue;
		}
		if (key === "clear-cache") {
			options.clearCache = true;
			continue;
		}
		if (key === "root") {
			const value = inlineValue ?? argv[++index];
			if (value) options.roots.push(value);
			continue;
		}
		const value = inlineValue ?? argv[++index];
		options[key] = value;
	}
	return { positionals, options };
}

function getRoots(options) {
	if (options.roots.length > 0) return options.roots;
	if (process.env.THAPLAN_ROOTS) return process.env.THAPLAN_ROOTS.split(path.delimiter).filter(Boolean);
	return [process.cwd()];
}

function planRows(options) {
	const plans = discoverPlans(getRoots(options), { noCache: options.noCache === true });
	const filtered = searchPlans(plans, options.search);
	return sortPlans(filtered, options.sort || "modified");
}

function formatDate(timestamp) {
	return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "—";
}

function listCommand(options) {
	const plans = planRows(options);
	if (options.json) {
		console.log(JSON.stringify(plans.map(serializePlan), null, 2));
		return;
	}
	if (plans.length === 0) {
		console.log("No plans found. Try --root PATH or set THAPLAN_ROOTS.");
		return;
	}
	console.log("STATUS               UPDATED     APP / PLAN");
	console.log("───────────────────  ──────────  ─────────────────────────────────────────────");
	for (const plan of plans) {
		const status = plan.complete ? plan.status : `${plan.status} / incomplete`;
		console.log(
			`${status.padEnd(18).slice(0, 18)} ${formatDate(plan.updatedAt).padEnd(10)}  ${plan.id}  ${plan.title}`,
		);
	}
	console.log(`\n${plans.length} plan${plans.length === 1 ? "" : "s"}.`);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function browserHtml(initialSearch = "") {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>thaplan — plans</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{color-scheme:light;--paper:#fbfbfa;--ink:#262626;--muted:#8f8f96;--rule:#d8d8dc;--soft:#f1f1f2;--focus:#55555d}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}
a{color:inherit}button,input,select{font:inherit;color:inherit;background:transparent;border:0}button{cursor:pointer}
.shell{max-width:1080px;margin:auto;padding:30px 42px 72px}.topbar{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:0 0 28px;border-bottom:1px solid var(--ink)}.brand{font-size:20px;letter-spacing:-.04em}.top-actions{display:flex;gap:18px;color:var(--muted);font-size:13px}.top-actions button:hover,.top-actions a:hover{text-decoration:underline;color:var(--ink)}
.hero{padding:58px 0 36px}.eyebrow{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.14em}.hero h1{font-size:clamp(34px,6vw,66px);font-weight:400;line-height:1.02;letter-spacing:-.07em;margin:14px 0}.hero p{max-width:600px;color:var(--muted);margin:0}.toolbar{display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--ink);padding:0 0 12px}.toolbar input{flex:1;outline:0;padding:10px 0}.toolbar select{color:var(--muted);outline:0}.count{color:var(--muted);font-size:13px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}.card{background:var(--paper);min-height:184px;padding:24px;display:flex;flex-direction:column;justify-content:space-between;transition:background .15s}.card:hover{background:var(--soft)}.card h2{font-size:20px;font-weight:400;letter-spacing:-.04em;margin:10px 0 8px}.card p{color:var(--muted);font-size:13px;margin:0}.meta{display:flex;justify-content:space-between;gap:12px;align-items:center;color:var(--muted);font-size:12px}.meta select{color:inherit;font-size:12px;border:1px solid var(--rule);padding:3px 6px;background:var(--paper);outline:0;cursor:pointer}.meta select:hover{border-color:var(--ink)}.tag{border:1px solid var(--rule);padding:2px 7px;text-transform:uppercase;letter-spacing:.08em}.empty{padding:40px 0;color:var(--muted)}
.detail{display:none}.detail.active{display:block}.index.hidden{display:none}.detail-head{padding:58px 0 26px;border-bottom:1px solid var(--ink);display:flex;justify-content:space-between;gap:20px}.detail-head h1{font-weight:400;font-size:clamp(30px,5vw,58px);letter-spacing:-.07em;line-height:1.03;margin:10px 0}.back{color:var(--muted);font-size:13px}.back:hover{text-decoration:underline;color:var(--ink)}.viewer{margin-top:28px;border:1px solid var(--rule);background:#fff;min-height:720px}.viewer iframe{display:block;width:100%;height:900px;border:0}.source{margin-top:18px;display:flex;gap:18px;color:var(--muted);font-size:13px}.source a:hover{color:var(--ink)}.view-tabs{display:flex;gap:18px;padding:16px 20px;border-bottom:1px solid var(--rule);font-size:13px;align-items:center}.view-tabs button{color:var(--muted);padding:0}.view-tabs button.active,.view-tabs button:hover{color:var(--ink);text-decoration:underline}.copy-btn{margin-left:auto;font-size:12px;border:1px solid var(--rule);padding:4px 10px;color:var(--muted)}.copy-btn:hover{color:var(--ink);border-color:var(--ink)}.markdown-view{padding:34px 42px;max-width:820px}.markdown-view h1,.markdown-view h2,.markdown-view h3{font-weight:400;letter-spacing:-.05em;line-height:1.12}.markdown-view h1{font-size:38px}.markdown-view h2{font-size:27px;margin-top:42px}.markdown-view h3{font-size:20px;margin-top:28px}.markdown-view p{margin:14px 0}.markdown-view ul,.markdown-view ol{padding-left:24px}.markdown-view li{margin:5px 0}.markdown-view code{background:var(--soft);padding:2px 5px;font-size:.9em}.markdown-view pre{overflow:auto;background:#292929;color:#f5f5f5;padding:18px;white-space:pre-wrap}.markdown-view pre code{background:transparent;padding:0}.markdown-view blockquote{margin:18px 0;padding-left:18px;border-left:2px solid var(--rule);color:var(--muted)}.markdown-editor{padding:24px}.markdown-editor textarea{display:block;width:100%;min-height:700px;resize:vertical;border:1px solid var(--rule);outline:0;padding:20px;background:var(--paper);color:var(--ink);font:14px/1.65 "JetBrains Mono",ui-monospace,monospace}.markdown-editor textarea:focus{border-color:var(--ink)}.editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;padding:0 0 16px}.save-button{border:1px solid var(--ink);padding:7px 14px}.save-button:hover{background:var(--ink);color:var(--paper)}.save-status{color:var(--muted);font-size:13px}footer{margin-top:72px;color:var(--muted);font-size:12px}
@media(max-width:700px){.shell{padding:22px 18px 48px}.topbar{align-items:flex-start}.top-actions{gap:10px}.grid{grid-template-columns:1fr}.viewer iframe{height:720px}.detail-head{display:block}.detail-head .back{display:block;margin-bottom:20px}}
</style></head>
<body><main class="shell">
<header class="topbar"><a class="brand" href="#">thaplan</a><nav class="top-actions"><button id="refresh">Refresh</button><a href="https://github.com/" target="_blank" rel="noreferrer">source</a></nav></header>
<section class="index" id="index"><div class="hero"><div class="eyebrow">plan browser</div><h1>Plans, in one quiet place.</h1><p>Browse implementation plans discovered across your repositories and app directories.</p></div><div class="toolbar"><input id="search" placeholder="Search plans, apps, tags…" autocomplete="off"><select id="sort"><option value="modified">Modified</option><option value="new">Newest</option><option value="old">Oldest</option><option value="title">Title</option><option value="path">Path</option></select></div><div class="count" id="count"></div><section class="grid" id="grid"></section></section>
<section class="detail" id="detail"><div class="detail-head"><div><button class="back" id="back">← Back to plans</button><div class="eyebrow" id="detail-app"></div><h1 id="detail-title"></h1><div class="meta" id="detail-meta"><select id="status-select"></select><span id="detail-date"></span></div></div></div><div class="source" id="source"></div><div class="viewer" id="viewer"></div></section>
<footer>thaplan · Markdown source + self-contained HTML visualization</footer></main>
<script>
const STATUS_OPTIONS=["unspecified","draft","proposed","reviewed","in-progress","completed","archived"];const initialSearch=${JSON.stringify(initialSearch)};let plans=[];const $=id=>document.getElementById(id);const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const params=new URLSearchParams({search:$("search").value,sort:$("sort").value});plans=await fetch('/api/plans?'+params).then(r=>r.json());render()}
function render(){
  $("count").textContent=plans.length+' plan'+(plans.length===1?'':'s');
  $("grid").innerHTML=plans.length?plans.map(p=>'<button class="card" data-id="'+esc(p.id)+'"><div><div class="eyebrow">'+esc(p.app)+'</div><h2>'+esc(p.title)+'</h2><p>'+esc(p.id)+'</p></div><div class="meta"><span class="tag">'+esc(p.complete?p.status:'incomplete')+'</span><span>'+esc(new Date(p.updatedAt).toISOString().slice(0,10))+'</span></div></button>').join(''):'<div class="empty">No matching plans.</div>';
  document.querySelectorAll('.card').forEach(card=>card.addEventListener('click',()=>openPlan(card.dataset.id)));
}
function markdownToHtml(source){
  const lines=String(source||'').replace(/^---[\\s\\S]*?\\n---\\s*/,'').split('\\n');let html='';let paragraph=[];let listType='';let inCode=false;let code=[];
  const flushParagraph=()=>{if(paragraph.length){html+='<p>'+paragraph.join(' ')+'</p>';paragraph=[]}};const closeList=()=>{if(listType){html+='</'+listType+'>';listType=''}};
  for(const line of lines){if(line.startsWith(String.fromCharCode(96).repeat(3))){flushParagraph();if(inCode){html+='<pre><code>'+esc(code.join('\\n'))+'</code></pre>';code=[];inCode=false}else{closeList();inCode=true}continue}if(inCode){code.push(line);continue}if(!line.trim()){flushParagraph();closeList();continue}let match=line.match(/^(#{1,3})\\s+(.+)$/);if(match){flushParagraph();closeList();html+='<h'+match[1].length+'>'+inlineMarkdown(match[2])+'</h'+match[1].length+'>';continue}match=line.match(/^[-*]\\s+(.+)$/);if(match){flushParagraph();if(listType!=='ul'){closeList();html+='<ul>';listType='ul'}html+='<li>'+inlineMarkdown(match[1])+'</li>';continue}match=line.match(/^\\d+\\.\\s+(.+)$/);if(match){flushParagraph();if(listType!=='ol'){closeList();html+='<ol>';listType='ol'}html+='<li>'+inlineMarkdown(match[1])+'</li>';continue}if(/^>\\s?/.test(line)){flushParagraph();closeList();html+='<blockquote>'+inlineMarkdown(line.replace(/^>\\s?/,''))+'</blockquote>';continue}if(/^---+$/.test(line.trim())){flushParagraph();closeList();html+='<hr>';continue}flushParagraph();paragraph.push(inlineMarkdown(line))}if(inCode)html+='<pre><code>'+esc(code.join('\\n'))+'</code></pre>';flushParagraph();closeList();return html}
function inlineMarkdown(value){return esc(value).replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').replace(/\\*([^*]+)\\*/g,'<em>$1</em>').replace(new RegExp(String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96),'g'),'<code>$1</code>').replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>')}
let currentMarkdown='';
function setView(kind,plan){const content=$("viewer-content");document.querySelectorAll('.view-tabs button').forEach(button=>button.classList.toggle('active',button.dataset.view===kind));if(kind==='html'){content.innerHTML='<iframe title="Plan visualization" src="/plan-html?id='+encodeURIComponent(plan.id)+'"></iframe>';return}if(kind==='raw'){content.innerHTML='<div class="markdown-editor"><div class="editor-actions"><span class="save-status" id="save-status">Changes are saved to the canonical .md file.</span><button class="save-button" id="save-markdown">Save Markdown</button></div><textarea id="markdown-editor" spellcheck="false"></textarea></div>';$("markdown-editor").value=plan.markdown||'';$("save-markdown").addEventListener('click',()=>saveMarkdown(plan));return}content.innerHTML='<div class="markdown-view">'+markdownToHtml(plan.markdown||'No Markdown source available.')+'</div>'}
async function saveMarkdown(plan){const status=$("save-status");const button=$("save-markdown");button.disabled=true;status.textContent='Saving…';try{const response=await fetch('/api/plan',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id:plan.id,markdown:$("markdown-editor").value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Save failed');currentMarkdown=result.markdown;plan.markdown=result.markdown;plan.updatedAt=result.updatedAt;status.textContent='Saved. The next agent run will read this Markdown.';document.querySelector('[data-view="rendered"]')?.click()}catch(error){status.textContent=error.message}finally{button.disabled=false}}
async function copyMarkdown(){const btn=$("copy-md");if(!btn)return;try{await navigator.clipboard.writeText(currentMarkdown);btn.textContent='Copied!';setTimeout(()=>{btn.textContent='Copy'},2000)}catch{btn.textContent='Failed'}}
async function openPlan(id,replace=false){const plan=await fetch('/api/plan?id='+encodeURIComponent(id)).then(r=>r.ok?r.json():null);if(!plan)return;currentMarkdown=plan.markdown||'';$("index").classList.add('hidden');$("detail").classList.add('active');$("detail-app").textContent=plan.app;$("detail-title").textContent=plan.title;$("detail-date").textContent=esc(new Date(plan.updatedAt).toISOString().slice(0,10));const sel=$("status-select");sel.innerHTML=STATUS_OPTIONS.map(s=>'<option value="'+esc(s)+'"'+(s===plan.status?' selected':'')+'>'+esc(s)+'</option>').join('');sel.onchange=()=>updateStatus(plan,sel.value);$('source').innerHTML=plan.htmlPath?'<a href="/plan-html?id='+encodeURIComponent(id)+'" target="_blank">Open HTML</a>':'';$('viewer').innerHTML='<div class="view-tabs"><button class="active" data-view="rendered">Rendered Markdown</button><button data-view="raw">Raw Markdown / Edit</button>'+(plan.htmlPath?'<button data-view="html">HTML visualization</button>':'')+'<button class="copy-btn" id="copy-md">Copy</button></div><div id="viewer-content"></div>';document.querySelectorAll('.view-tabs button').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view,plan)));$("copy-md").addEventListener('click',copyMarkdown);setView('rendered',plan);if(!replace)history.pushState({id},'', '#plan='+encodeURIComponent(id))}
async function updateStatus(plan,newStatus){const sel=$("status-select");sel.disabled=true;try{const response=await fetch('/api/plan',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id:plan.id,status:newStatus})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Failed to update status');plan.status=result.status;sel.innerHTML=STATUS_OPTIONS.map(s=>'<option value="'+esc(s)+'"'+(s===result.status?' selected':'')+'>'+esc(s)+'</option>').join('')}catch(error){sel.value=plan.status;alert(error.message)}finally{sel.disabled=false}}
function showIndex(replace=false){$("detail").classList.remove('active');$("index").classList.remove('hidden');if(!replace)history.pushState({},'', '#');}
$("search").value=initialSearch;$("search").addEventListener('input',load);$("sort").addEventListener('change',load);$("refresh").addEventListener('click',load);$("back").addEventListener('click',()=>showIndex());window.addEventListener('popstate',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('plan');id?openPlan(id,true):showIndex(true)});
const start=new URLSearchParams(location.hash.slice(1)).get('plan');load().then(()=>start&&openPlan(start,true));
</script></body></html>`;
}

function findPlan(plans, id) {
	return plans.find((plan) => plan.id === id);
}

function send(res, status, contentType, body) {
	res.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store" });
	res.end(body);
}

function readRequestBody(req, limit = 5 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				reject(new Error("Request body is too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function writePlanMarkdown(plan, markdown) {
	if (!plan.markdownPath) throw new Error("This plan has no Markdown source to edit");
	const temporaryPath = `${plan.markdownPath}.thaplan-${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporaryPath, plan.markdownPath);
	return fs.statSync(plan.markdownPath).mtimeMs;
}

const STATUS_OPTIONS = ["unspecified", "draft", "proposed", "reviewed", "in-progress", "completed", "archived"];

function serveCommand(options, initialPlan) {
	const port = Number(options.port || DEFAULT_PORT);
	const roots = getRoots(options);
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const plans = discoverPlans(roots, { noCache: options.noCache === true });
		if (url.pathname === "/api/plans") {
			const filtered = sortPlans(
				searchPlans(plans, url.searchParams.get("search") || ""),
				url.searchParams.get("sort") || "modified",
			);
			return send(res, 200, "application/json", JSON.stringify(filtered.map(serializePlan)));
		}
		if (url.pathname === "/api/plan") {
			const plan = findPlan(plans, url.searchParams.get("id"));
			if (!plan) return send(res, 404, "application/json", JSON.stringify({ error: "Plan not found" }));
			if (req.method === "PUT") {
				try {
					const payload = JSON.parse(await readRequestBody(req));
					if (typeof payload.markdown === "string") {
						const updatedAt = writePlanMarkdown(plan, payload.markdown);
						return send(
							res,
							200,
							"application/json",
							JSON.stringify({ ...serializePlan(plan), markdown: payload.markdown, updatedAt }),
						);
					}
					if (typeof payload.status === "string") {
						if (!STATUS_OPTIONS.includes(payload.status))
							throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);
						const updatedAt = updatePlanStatus(plan, payload.status);
						plan.status = payload.status;
						return send(
							res,
							200,
							"application/json",
							JSON.stringify({ ...serializePlan(plan), updatedAt }),
						);
					}
					throw new Error('Request must include "markdown" or "status"');
				} catch (error) {
					return send(res, 400, "application/json", JSON.stringify({ error: error.message }));
				}
			}
			return send(res, 200, "application/json", JSON.stringify(serializePlan(readPlanDetail(plan))));
		}
		if (url.pathname === "/plan-html") {
			const plan = findPlan(plans, url.searchParams.get("id"));
			if (!plan?.htmlPath) return send(res, 404, "text/plain", "HTML plan not found");
			return send(res, 200, "text/html", fs.readFileSync(plan.htmlPath, "utf8"));
		}
		if (url.pathname === "/plan-md") {
			const plan = findPlan(plans, url.searchParams.get("id"));
			if (!plan?.markdownPath) return send(res, 404, "text/plain", "Markdown plan not found");
			return send(res, 200, "text/markdown", fs.readFileSync(plan.markdownPath, "utf8"));
		}
		if (url.pathname === "/favicon.svg") {
			const faviconPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "thaplan-favicon.svg");
			try {
				return send(res, 200, "image/svg+xml", fs.readFileSync(faviconPath, "utf8"));
			} catch {
				return send(res, 404, "text/plain", "Favicon not found");
			}
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return send(res, 200, "text/html", browserHtml(options.search || ""));
		}
		return send(res, 404, "text/plain", "Not found");
	});
	server.on("error", (error) => {
		console.error(`thaplan server: ${error.message}`);
		process.exitCode = 1;
	});
	server.listen(port, "127.0.0.1", () => {
		const suffix = initialPlan ? `#plan=${encodeURIComponent(initialPlan)}` : "";
		console.log(`thaplan browser: http://localhost:${port}/${suffix}`);
		console.log(`roots: ${roots.map((root) => path.resolve(root)).join(", ")}`);
	});
}

function runPi(model, prompt, tools, appendSystemPrompt) {
	const args = ["--no-session", "--mode", "print", "-p", "--model", model, "--tools", tools.join(",")];
	if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
	args.push(prompt);
	const result = spawnSync("pi", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 8, env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr?.trim() || `pi exited with status ${result.status}`);
	return result.stdout.trim();
}

function repositoryCandidates(options) {
	const candidates = new Set(getRoots(options).map((root) => path.resolve(root)));
	const searchDirectories = [
		os.homedir(),
		path.join(os.homedir(), "src"),
		path.join(os.homedir(), "code"),
		path.join(os.homedir(), "projects"),
		path.join(os.homedir(), "workspaces"),
	];
	for (const parent of searchDirectories) {
		let entries;
		try {
			entries = fs.readdirSync(parent, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const candidate = path.join(parent, entry.name);
			if (fs.existsSync(path.join(candidate, ".git")) || discoverPlans([candidate]).length > 0)
				candidates.add(candidate);
		}
	}
	return [...candidates]
		.filter((candidate) => discoverPlans([candidate]).length > 0 || candidate === path.resolve(process.cwd()))
		.sort();
}

function isCancelled(value) {
	if (p.isCancel(value)) {
		p.cancel("Cancelled.");
		return true;
	}
	return false;
}

async function interactiveCommand(options) {
	p.intro(chalk.bgWhite(chalk.black(" thaplan ")));
	const candidates = repositoryCandidates(options);
	const selected = await p.multiselect({
		message: "Which repositories should thaplan include?",
		options: candidates.map((candidate) => ({
			value: candidate,
			label: path.basename(candidate) || candidate,
			hint: `${candidate} · ${discoverPlans([candidate]).length} plans`,
		})),
		initialValues: candidates.slice(0, 1),
		required: true,
	});
	if (isCancelled(selected)) return 130;

	const action = await p.select({
		message: "What do you want to do?",
		options: [
			{ value: "list", label: "List plans", hint: "show plans in the terminal" },
			{ value: "browser", label: "Open plan browser", hint: "search, edit, and view plans on the web" },
			{ value: "generate", label: "Generate a plan", hint: "ask DeepSeek to create a Markdown plan" },
		],
	});
	if (isCancelled(action)) return 130;

	const scopedOptions = { ...options, roots: selected };
	if (action === "list") {
		listCommand(scopedOptions);
		p.outro(chalk.dim("Use Open plan browser to edit and save a plan."));
		return 0;
	}
	if (action === "generate") {
		const name = await p.text({ message: "Plan name (kebab-case):", placeholder: "inventory-v2" });
		if (isCancelled(name)) return 130;
		const prompt = await p.text({
			message: "What should the plan cover?",
			placeholder: "Describe the feature or problem",
		});
		if (isCancelled(prompt)) return 130;
		p.outro(chalk.dim("Starting plan browser with your new plan..."));
		generateCommand({ ...scopedOptions, name, prompt }, []);
		return 0;
	}
	const port = await p.text({ message: "Browser port:", initialValue: String(options.port || DEFAULT_PORT) });
	if (isCancelled(port)) return 130;
	serveCommand({ ...scopedOptions, port });
	return 0;
}

function generateCommand(options, positionals) {
	const name = options.name || positionals[0];
	if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name))
		throw new Error("generate requires --name with kebab-case, for example --name auth-redesign");
	const root = path.resolve(options.root || getRoots(options)[0]);
	const planDirectory = path.join(root, "docs", "plans");
	const markdownPath = path.join(planDirectory, `${name}.md`);
	fs.mkdirSync(planDirectory, { recursive: true });

	let referenceBrief = "No image reference was supplied.";
	if (options["reference-image"]) {
		const imagePath = path.resolve(options["reference-image"]);
		if (!fs.existsSync(imagePath)) throw new Error(`Reference image not found: ${imagePath}`);
		referenceBrief = runPi(
			CODEX_VISION_MODEL,
			`Use the read tool to inspect this image: ${imagePath}\nDescribe only the layout, spacing, typography, colors, controls, and visual rules that a plan-authoring agent should reproduce. Return a concise design brief.`,
			["read"],
		);
	}

	const rolePath = path.join(os.homedir(), ".pi", "agent", "agents", "thaplan.md");
	if (!fs.existsSync(rolePath)) throw new Error(`thaplan role is not installed: ${rolePath}`);
	const prompt = `Create the thaplan plan now.\n\nOutput directory: ${planDirectory}\nMarkdown output: ${markdownPath}\nUser request: ${options.prompt || positionals.slice(1).join(" ") || "Create an implementation plan for this repository."}\n\nReference design brief:\n${referenceBrief}`;
	console.log(runPi(DEEPSEEK_MODEL, prompt, ["read", "write", "edit", "grep", "find", "ls", "bash"], rolePath));
	if (!fs.existsSync(markdownPath)) throw new Error(`Generation completed without creating ${markdownPath}`);
	console.log(`Created:\n- ${markdownPath}`);

	// Auto-start the plan browser pointing directly to the new plan
	const planId = `docs/plans/${name}`;
	const port = Number(options.port || DEFAULT_PORT);
	console.log(`\n${chalk.bold("→")} Opening plan browser at ${chalk.cyan(`http://localhost:${port}/#plan=${encodeURIComponent(planId)}`)}`);
	console.log(chalk.dim("  Press Ctrl+C to stop the server when you're done.\n"));
	serveCommand({ ...options, roots: options.roots || [root], port }, planId);
}

function readCommand(options, positionals) {
	const planId = positionals[0];
	if (!planId) throw new Error("read requires a PLAN_ID, e.g. thaplan read docs/plans/thaplan");
	const plans = planRows(options);
	const plan = plans.find((p) => p.id === planId);
	if (!plan) throw new Error(`Plan not found: ${planId}`);
	if (!plan.markdownPath) throw new Error(`Plan has no Markdown source: ${planId}`);
	const detail = readPlanDetail(plan);
	console.log(renderMarkdownToTerminal(detail.markdown));
}

const { positionals, options } = parseArgs(process.argv.slice(2));

async function main() {
	if (options.help || positionals[0] === "help") return usage();

	if (options.clearCache) {
		const cachePath = path.join(os.homedir(), ".local", "share", "thaplan", "plan-cache.json");
		try {
			fs.unlinkSync(cachePath);
			console.log("Cleared thaplan plan cache.");
		} catch {
			console.log("No cache to clear.");
		}
		if (!positionals[0]) return 0;
	}

	const command = positionals[0];
	try {
		if (!command && process.stdin.isTTY && process.stdout.isTTY) return interactiveCommand(options);
		if (!command || command === "list") return listCommand(options);
		if (command === "serve") return serveCommand(options);
		if (command === "read") return readCommand(options, positionals.slice(1));
		if (command === "open") return serveCommand(options, positionals[1]);
		// generate auto-starts the server, so don't exit after it
		if (command === "generate") { generateCommand(options, positionals.slice(1)); return; }
		throw new Error(`Unknown command: ${command}`);
	} catch (error) {
		console.error(`thaplan: ${error.message}`);
		process.exitCode = 1;
	}
}

await main();
