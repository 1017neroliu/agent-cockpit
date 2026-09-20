/**
 * agent-cockpit —— 多 Agent 统一管理面板(服务端,零依赖)
 *
 * 管理范围:
 *   · agent-notify 通知配置(委托 core/notify.sh,保证行为一致)
 *   · 各 agent 的模型 / API key / Base URL(Pi settings+models.json, Claude settings.json,
 *     Codex config.toml+auth.json)
 *   · Skills 管理(Pi / Claude Code / 共享 ~/.agents)
 *   · 插件/扩展管理(Pi extensions+packages, Claude plugins)
 *   · 原始配置文件编辑(全部带自动备份)
 *
 * 安全:只绑定 127.0.0.1;所有写入先备份为 *.bak-cockpit 再原子落盘。
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const VERSION = "1.0.0";
const HOME = os.homedir();
const PORT = Number(process.env.COCKPIT_PORT || 8621);
const WEB_DIR = path.join(__dirname, "..", "web");

// ---------------------------------------------------------------- 路径与常量
const P = {
	agentNotifyConf: path.join(HOME, ".agent-notify", "notify.conf"),
	agentNotifyCore: path.join(HOME, ".agent-notify", "core", "notify.sh"),
	piSettings: path.join(HOME, ".pi", "agent", "settings.json"),
	piModels: path.join(HOME, ".pi", "agent", "models.json"),
	piAuth: path.join(HOME, ".pi", "agent", "auth.json"),
	piExtDir: path.join(HOME, ".pi", "agent", "extensions"),
	piSkillsDir: path.join(HOME, ".pi", "agent", "skills"),
	piNpmDir: path.join(HOME, ".pi", "agent", "npm"),
	piGitDir: path.join(HOME, ".pi", "agent", "git"),
	claudeSettings: path.join(HOME, ".claude", "settings.json"),
	claudeSkillsDir: path.join(HOME, ".claude", "skills"),
	claudePluginsDir: path.join(HOME, ".claude", "plugins"),
	codexConfig: path.join(HOME, ".codex", "config.toml"),
	codexAuth: path.join(HOME, ".codex", "auth.json"),
	sharedSkillsDir: path.join(HOME, ".agents", "skills"),
};

const AGENTS = {
	"claude-code": { label: "Claude Code", dir: path.join(HOME, ".claude") },
	pi: { label: "Pi", dir: path.join(HOME, ".pi", "agent") },
	codex: { label: "Codex", dir: path.join(HOME, ".codex") },
};

// ---------------------------------------------------------------- 基础工具
function maskKey(v) {
	if (typeof v !== "string" || v.length <= 8) return v ? "••••" : "";
	return v.slice(0, 6) + "••••" + v.slice(-4);
}

async function readJson(file) {
	try {
		return JSON.parse(await fsp.readFile(file, "utf8"));
	} catch {
		return null;
	}
}

/** 带备份的原子写:*.bak-cockpit 滚动备份,tmp+rename 原子替换 */
async function writeFileSafe(file, content) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	try {
		await fsp.copyFile(file, file + ".bak-cockpit");
	} catch {
		/* 首次创建无备份 */
	}
	const tmp = file + ".tmp-cockpit";
	await fsp.writeFile(tmp, content, "utf8");
	await fsp.rename(tmp, file);
}

async function writeJsonSafe(file, obj) {
	await writeFileSafe(file, JSON.stringify(obj, null, 2) + "\n");
}

/** 执行命令并取回输出 */
function run(cmd, args, timeoutMs = 15000) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 512, cwd: HOME }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: (stdout || "").trim(), stderr: (stderr || "").trim(), error: err ? err.message : "" });
		});
	});
}

// ---------------------------------------------------------------- agent-notify(委托核心)
function notifyConfRead() {
	const def = {
		terminal: "no", local_sound: "yes", desktop_popup: "yes",
		bark: "no", bark_key: "", wled: "no", wled_ip: "",
		min_task_seconds: "180", agents: "", sound_done: "", sound_stuck: "",
	};
	let text = "";
	try {
		text = fs.readFileSync(P.agentNotifyConf, "utf8");
	} catch {
		return { exists: false, conf: def };
	}
	const conf = { ...def };
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#") || t.startsWith(";")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const k = t.slice(0, eq).trim();
		if (k in conf) conf[k] = t.slice(eq + 1).split("#")[0].trim();
	}
	return { exists: true, conf };
}

async function notifySet(key, value) {
	if (fs.existsSync(P.agentNotifyCore)) {
		const r = await run("bash", [P.agentNotifyCore, "set", key, value]);
		if (r.ok) return true;
	}
	// 核心不在时兜底:直接改 INI
	return iniSet(P.agentNotifyConf, key, value);
}

/** 极简 INI 写入(与核心 set_opt 行为一致) */
async function iniSet(file, key, value) {
	let text = "";
	try {
		text = await fsp.readFile(file, "utf8");
	} catch {
		text = "";
	}
	const re = new RegExp(`^#?${key}=.*$`, "m");
	if (re.test(text)) text = text.replace(re, `${key}=${value}`);
	else text = text.replace(/\s+$/, "") + (text ? "\n" : "") + `${key}=${value}\n`;
	await writeFileSafe(file, text);
	return true;
}

// ---------------------------------------------------------------- TOML(codex)辅助:顶层键的读改
function tomlGetTop(text, key) {
	const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
	return m ? m[1] : "";
}

/** 顶层字符串键赋值:存在则替换,不存在则插到第一个 [table] 之前 */
function tomlSetTop(text, key, value) {
	const re = new RegExp(`^\\s*${key}\\s*=\\s*"[^"]*"[ \\t]*(?=#|$)`, "m");
	if (re.test(text)) return text.replace(re, `${key} = "${value}"`);
	const line = `${key} = "${value}"`;
	const tableIdx = text.search(/^\s*\[/m);
	if (tableIdx < 0) return text.replace(/\s*$/, "\n") + line + "\n";
	// 插到第一个 [table] 前
	const before = text.slice(0, tableIdx).replace(/\n*$/, "\n");
	const after = text.slice(tableIdx);
	return before + line + "\n" + after;
}

/** 解析 [model_providers.X] 表为对象(仅处理平铺键) */
function tomlParseProviders(text) {
	const out = {};
	const re = /^\[model_providers\.([^"\]]+)\]\s*$([\s\S]*?)(?=^\[|\s*$)/gm;
	let m;
	while ((m = re.exec(text))) {
		const name = m[1];
		const body = m[2];
		const tbl = {};
		for (const line of body.split("\n")) {
			const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*(?=#|$)/);
			if (!kv) continue;
			let v = kv[2].trim();
			if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
			else if (/^\d+$/.test(v)) v = Number(v);
			else if (v === "true" || v === "false") v = v === "true";
			tbl[kv[1]] = v;
		}
		out[name] = tbl;
	}
	return out;
}

// ---------------------------------------------------------------- Skills / 扩展发现
function parseSkillMd(file) {
	try {
		const text = fs.readFileSync(file, "utf8");
		const fm = text.match(/^---\n([\s\S]*?)\n---/);
		const meta = {};
		if (fm) {
			for (const line of fm[1].split("\n")) {
				const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
				if (kv) meta[kv[1]] = kv[2].trim();
			}
		}
		// 没有元数据时用第一个标题
		const h1 = text.match(/^#\s+(.+)$/m);
		return {
			name: meta.name || "",
			description: meta.description || "",
			fallbackTitle: h1 ? h1[1] : "",
		};
	} catch {
		return { name: "", description: "", fallbackTitle: "" };
	}
}

function listSkills(dir) {
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const base = e.name.replace(/\.disabled$/, "");
		if (e.isFile() && e.name.endsWith(".md")) {
			// 单文件 skill:xxx.md
			const meta = parseSkillMd(path.join(dir, e.name));
			out.push({ name: base.replace(/\.md$/, ""), dir: false, disabled: e.name.endsWith(".disabled"), ...meta });
		} else if (e.isDirectory()) {
			const skillMd = path.join(dir, e.name, "SKILL.md");
			if (fs.existsSync(skillMd)) {
				const meta = parseSkillMd(skillMd);
				out.push({ name: base, dir: true, disabled: e.name.endsWith(".disabled"), ...meta });
			}
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

function listPiExtensions() {
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync(P.piExtDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isFile() && e.name.endsWith(".ts")) {
			out.push({ name: e.name.replace(/\.ts$/, ""), type: "file", desc: firstComment(path.join(P.piExtDir, e.name)) });
		} else if (e.isDirectory()) {
			const idx = path.join(P.piExtDir, e.name, "index.ts");
			if (fs.existsSync(idx)) {
				out.push({ name: e.name, type: "dir", desc: firstComment(idx) });
			}
		}
	}
	return out;
}

function firstComment(file) {
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (const l of lines.slice(0, 12)) {
			const m = l.match(/^\s*(?:\/\/|#|\*)\s*(.+)/);
			if (m) return m[1].trim().slice(0, 120);
		}
	} catch {}
	return "";
}

async function listPiPackages() {
	const out = [];
	for (const base of [P.piNpmDir, P.piGitDir]) {
		const kind = base === P.piNpmDir ? "npm" : "git";
		let entries = [];
		try {
			entries = await fsp.readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const pkg = await readJson(path.join(base, e.name, "package.json"));
			out.push({ name: e.name, kind, version: pkg?.version || "", desc: (pkg?.description || "").slice(0, 120) });
		}
	}
	return out;
}

async function listClaudePlugins() {
	const out = [];
	const installed = await readJson(path.join(P.claudePluginsDir, "installed_plugins.json"));
	const cacheDir = path.join(P.claudePluginsDir, "cache");
	try {
		for (const repo of await fsp.readdir(cacheDir, { withFileTypes: true })) {
			if (!repo.isDirectory()) continue;
			const pkg = await readJson(path.join(cacheDir, repo.name, ".claude-plugin", "plugin.json"));
			const enabledInfo = installed?.repositories?.[repo.name];
			out.push({
				name: pkg?.name || repo.name,
				repo: repo.name,
				version: pkg?.version || "",
				desc: (pkg?.description || "").slice(0, 120),
				enabled: enabledInfo ? true : null,
			});
		}
	} catch {}
	return out;
}

// ---------------------------------------------------------------- 状态聚合
async function buildState() {
	const state = { cockpit: { version: VERSION, port: PORT }, agents: {}, notify: {}, shared: {} };

	// agent-notify
	const nc = notifyConfRead();
	state.notify = {
		installed: fs.existsSync(P.agentNotifyCore),
		conf: nc.conf,
		confExists: nc.exists,
		enabledAgents: nc.conf.agents ? nc.conf.agents.split(",").map((s) => s.trim()).filter(Boolean) : [],
	};

	// Pi
	const piSettings = (await readJson(P.piSettings)) || {};
	const piModels = await readJson(P.piModels);
	const piProviders = [];
	if (piModels?.providers) {
		for (const [id, p] of Object.entries(piModels.providers)) {
			piProviders.push({
				id,
				baseUrl: p.baseUrl || "",
				api: p.api || "",
				apiKeyMasked: maskKey(p.apiKey || ""),
				apiKeySet: Boolean(p.apiKey),
				models: (p.models || []).map((m) => m.id),
			});
		}
	}
	state.agents.pi = {
		detected: fs.existsSync(P.piSettings),
		label: AGENTS.pi.label,
		settings: {
			defaultProvider: piSettings.defaultProvider || "",
			defaultModel: piSettings.defaultModel || "",
			theme: piSettings.theme || "",
		},
		providers: piProviders,
		skills: listSkills(P.piSkillsDir),
		extensions: listPiExtensions(),
		packages: await listPiPackages(),
	};

	// Claude Code
	const claudeSettings = (await readJson(P.claudeSettings)) || {};
	state.agents["claude-code"] = {
		detected: fs.existsSync(path.join(HOME, ".claude")),
		label: AGENTS["claude-code"].label,
		settings: {
			model: claudeSettings.model || "",
			envAnthropicBaseUrl: claudeSettings.env?.ANTHROPIC_BASE_URL || "",
			envAnthropicApiKeyMasked: maskKey(claudeSettings.env?.ANTHROPIC_API_KEY || ""),
			envAnthropicApiKeySet: Boolean(claudeSettings.env?.ANTHROPIC_API_KEY),
		},
		skills: listSkills(P.claudeSkillsDir),
		plugins: await listClaudePlugins(),
	};

	// Codex
	let codexToml = "";
	try {
		codexToml = await fsp.readFile(P.codexConfig, "utf8");
	} catch {}
	const codexAuth = (await readJson(P.codexAuth)) || {};
	state.agents.codex = {
		detected: fs.existsSync(P.codexConfig),
		label: AGENTS.codex.label,
		settings: {
			model: tomlGetTop(codexToml, "model"),
			modelProvider: tomlGetTop(codexToml, "model_provider"),
			notify: tomlGetTop(codexToml, "notify"),
		},
		providers: Object.entries(tomlParseProviders(codexToml)).map(([id, t]) => ({
			id,
			baseUrl: t.base_url || "",
			envKey: t.env_key || "",
			wireApi: t.wire_api || "",
		})),
		auth: {
			mode: codexAuth.auth_mode || "",
			apiKeyMasked: maskKey(codexAuth.OPENAI_API_KEY || ""),
			apiKeySet: Boolean(codexAuth.OPENAI_API_KEY),
		},
	};

	// 共享 skills
	state.shared.skills = listSkills(P.sharedSkillsDir);

	return state;
}

// ---------------------------------------------------------------- 写操作
async function saveNotifyConf(conf) {
	// 逐键委托给 agent-notify 核心(与 CLI 行为完全一致)
	const keys = ["terminal", "local_sound", "desktop_popup", "bark", "bark_key", "wled", "wled_ip", "min_task_seconds", "agents", "sound_done", "sound_stuck"];
	for (const k of keys) {
		if (conf[k] !== undefined) await notifySet(k, String(conf[k]));
	}
	return true;
}

async function savePiSettings(values) {
	const cur = (await readJson(P.piSettings)) || {};
	if (values.defaultProvider !== undefined) cur.defaultProvider = values.defaultProvider || undefined;
	if (values.defaultModel !== undefined) cur.defaultModel = values.defaultModel || undefined;
	if (cur.defaultProvider === undefined) delete cur.defaultProvider;
	if (cur.defaultModel === undefined) delete cur.defaultModel;
	await writeJsonSafe(P.piSettings, cur);
}

/** models.json provider 增改删;newKey 为空表示不修改 apiKey */
async function savePiProvider(action, data) {
	const models = (await readJson(P.piModels)) || { providers: {} };
	models.providers = models.providers || {};
	if (action === "delete") {
		delete models.providers[data.id];
	} else if (action === "create" || action === "update") {
		const id = data.id;
		if (!id) throw new Error("provider id 不能为空");
		const cur = models.providers[id] || {};
		const next = { ...cur };
		if (data.baseUrl !== undefined) next.baseUrl = data.baseUrl;
		if (data.api !== undefined) next.api = data.api;
		if (data.newApiKey) next.apiKey = data.newApiKey;
		models.providers[id] = next;
	}
	await writeJsonSafe(P.piModels, models);
}

async function saveClaudeSettings(values) {
	const cur = (await readJson(P.claudeSettings)) || {};
	if (values.model !== undefined) {
		if (values.model) cur.model = values.model;
		else delete cur.model;
	}
	for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]) {
		const v = values[k];
		if (v !== undefined) {
			cur.env = cur.env || {};
			if (v === null || v === "") delete cur.env[k];
			else cur.env[k] = v;
			if (Object.keys(cur.env).length === 0) delete cur.env;
		}
	}
	await writeJsonSafe(P.claudeSettings, cur);
}

async function saveCodexConfig(values) {
	let text = "";
	try {
		text = await fsp.readFile(P.codexConfig, "utf8");
	} catch {
		text = "";
	}
	if (values.model !== undefined && values.model) text = tomlSetTop(text, "model", values.model);
	if (values.modelProvider !== undefined && values.modelProvider) text = tomlSetTop(text, "model_provider", values.modelProvider);
	await writeFileSafe(P.codexConfig, text);
}

async function saveCodexAuth(apiKey) {
	const cur = (await readJson(P.codexAuth)) || {};
	if (apiKey) {
		cur.auth_mode = "apikey";
		cur.OPENAI_API_KEY = apiKey;
	} else {
		delete cur.OPENAI_API_KEY;
	}
	await writeJsonSafe(P.codexAuth, cur);
}

// skills / 扩展管理
async function manageSkill(agent, action, name) {
	const dirs = {
		pi: P.piSkillsDir,
		"claude-code": P.claudeSkillsDir,
		shared: P.sharedSkillsDir,
	};
	const dir = dirs[agent];
	if (!dir) throw new Error("未知 agent: " + agent);
	const disabled = (n) => path.join(dir, n + ".disabled");
	const enabled = (n) => {
		const p1 = path.join(dir, n);
		if (fs.existsSync(p1)) return p1;
		return path.join(dir, n + ".disabled");
	};
	switch (action) {
		case "delete": {
			const target = enabled(name);
			await fsp.rm(target, { recursive: true, force: true });
			return { deleted: target };
		}
		case "disable": {
			const target = enabled(name);
			const dest = disabled(name);
			await fsp.rename(target, dest);
			return { disabled: dest };
		}
		case "enable": {
			const target = disabled(name);
			if (!fs.existsSync(target)) throw new Error("未找到(可能本就启用): " + name);
			await fsp.rename(target, path.join(dir, name));
			return { enabled: name };
		}
		case "create": {
			const skillDir = path.join(dir, name);
			if (fs.existsSync(skillDir)) throw new Error("已存在: " + name);
			const tpl = `---\nname: ${name}\ndescription: 在这里写这个 skill 的用途(何时使用它)\n---\n\n# ${name}\n\n在这里写具体步骤/指南。\n`;
			await fsp.mkdir(skillDir, { recursive: true });
			await fsp.writeFile(path.join(skillDir, "SKILL.md"), tpl, "utf8");
			return { created: skillDir };
		}
		default:
			throw new Error("未知操作: " + action);
	}
}

async function deletePiExtension(name) {
	const f1 = path.join(P.piExtDir, name + ".ts");
	const f2 = path.join(P.piExtDir, name);
	if (fs.existsSync(f1)) {
		await writeFileSafe(f1, await fsp.readFile(f1, "utf8")); // 删除前也留备份
		await fsp.rm(f1, { force: true });
		return { deleted: f1 };
	}
	if (fs.existsSync(f2)) {
		await fsp.rm(f2, { recursive: true, force: true });
		return { deleted: f2 };
	}
	throw new Error("未找到扩展: " + name);
}

// ---------------------------------------------------------------- HTTP 服务
function json(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > 1024 * 1024) reject(new Error("body 过大"));
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (e) {
				reject(new Error("JSON 解析失败: " + e.message));
			}
		});
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const route = url.pathname;
	try {
		// 静态前端
		if (req.method === "GET" && (route === "/" || route === "/index.html")) {
			const html = await fsp.readFile(path.join(WEB_DIR, "index.html"), "utf8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(html);
		}
		if (req.method === "GET" && route === "/api/state") {
			return json(res, 200, await buildState());
		}

		// ---- agent-notify ----
		if (route === "/api/notify/conf" && req.method === "PUT") {
			const body = await readBody(req);
			await saveNotifyConf(body.conf || body);
			return json(res, 200, { ok: true, conf: notifyConfRead().conf });
		}
		if (route === "/api/notify/test" && req.method === "POST") {
			const body = await readBody(req);
			const agent = body.agent || "";
			if (!fs.existsSync(P.agentNotifyCore)) return json(res, 400, { ok: false, error: "未找到 agent-notify 核心" });
			const args = ["test"];
			if (agent) args.push("--agent", agent);
			const r = await run("bash", [P.agentNotifyCore, ...args], 30000);
			return json(res, 200, { ok: r.ok, output: r.stdout || r.stderr });
		}
		if (route === "/api/notify/mode" && req.method === "POST") {
			const body = await readBody(req);
			const r = await run("bash", [P.agentNotifyCore, "mode", String(body.mode || "")]);
			return json(res, r.ok ? 200 : 400, { ok: r.ok, output: r.stdout || r.stderr });
		}

		// ---- agent 配置 ----
		let m;
		if ((m = route.match(/^\/api\/agent\/([\w-]+)\/config$/)) && req.method === "PUT") {
			const agent = m[1];
			const body = await readBody(req);
			if (agent === "pi") await savePiSettings(body);
			else if (agent === "claude-code") await saveClaudeSettings(body);
			else if (agent === "codex") await saveCodexConfig(body);
			else return json(res, 404, { error: "未知 agent" });
			return json(res, 200, { ok: true });
		}
		if ((m = route.match(/^\/api\/agent\/pi\/providers?$/)) && (req.method === "POST" || req.method === "PUT")) {
			const body = await readBody(req);
			await savePiProvider(body.action || "update", body);
			return json(res, 200, { ok: true });
		}
		if ((m = route.match(/^\/api\/agent\/codex\/auth$/)) && req.method === "PUT") {
			const body = await readBody(req);
			await saveCodexAuth(body.apiKey || "");
			return json(res, 200, { ok: true });
		}

		// ---- skills ----
		if ((m = route.match(/^\/api\/skills\/([\w-]+)$/)) && req.method === "POST") {
			const body = await readBody(req);
			const r = await manageSkill(m[1], body.action, body.name);
			return json(res, 200, { ok: true, result: r });
		}

		// ---- pi 扩展 ----
		if (route === "/api/agent/pi/extensions" && req.method === "POST") {
			const body = await readBody(req);
			if (body.action === "delete") {
				const r = await deletePiExtension(body.name);
				return json(res, 200, { ok: true, result: r });
			}
			return json(res, 400, { error: "未知操作" });
		}

		// ---- 原始配置文件 ----
		if (route === "/api/files" && req.method === "GET") {
			const files = [
				{ id: "notify", label: "agent-notify 通知配置", path: P.agentNotifyConf, lang: "ini" },
				{ id: "pi-settings", label: "Pi 设置", path: P.piSettings, lang: "json" },
				{ id: "pi-models", label: "Pi 模型/Provider", path: P.piModels, lang: "json" },
				{ id: "claude-settings", label: "Claude Code 设置", path: P.claudeSettings, lang: "json" },
				{ id: "codex-config", label: "Codex 配置 (TOML)", path: P.codexConfig, lang: "toml" },
			].filter((f) => fs.existsSync(f.path));
			return json(res, 200, { files });
		}
		if (route === "/api/files/read" && req.method === "POST") {
			const body = await readBody(req);
			const known = [P.agentNotifyConf, P.piSettings, P.piModels, P.claudeSettings, P.codexConfig, P.codexAuth];
			if (!known.includes(body.path)) return json(res, 403, { error: "只允许读取白名单内的配置文件" });
			const content = await fsp.readFile(body.path, "utf8");
			return json(res, 200, { content });
		}
		if (route === "/api/files/write" && req.method === "POST") {
			const body = await readBody(req);
			const known = [P.agentNotifyConf, P.piSettings, P.piModels, P.claudeSettings, P.codexConfig, P.codexAuth];
			if (!known.includes(body.path)) return json(res, 403, { error: "只允许写白名单内的配置文件" });
			if (body.path.endsWith(".json")) JSON.parse(body.content); // JSON 先校验
			await writeFileSafe(body.path, body.content);
			return json(res, 200, { ok: true });
		}

		return json(res, 404, { error: "not found: " + route });
	} catch (e) {
		return json(res, 500, { error: e.message || String(e) });
	}
});

server.on("error", (e) => {
	if (e.code === "EADDRINUSE") {
		console.error(`端口 ${PORT} 已被占用(可能 cockpit 已在运行),直接访问 http://127.0.0.1:${PORT}`);
		process.exit(0);
	}
	console.error(e.message);
	process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`agent-cockpit v${VERSION} 已启动: http://127.0.0.1:${PORT}  (Ctrl+C 停止)`);
});
