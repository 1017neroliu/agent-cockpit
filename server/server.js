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
	claudeProviders: path.join(HOME, ".agent-cockpit", "claude-providers.json"),
	codexSkillsDir: path.join(HOME, ".codex", "skills"),
	codexConfig: path.join(HOME, ".codex", "config.toml"),
	codexAuth: path.join(HOME, ".codex", "auth.json"),
	codexProfileGlm: path.join(HOME, ".codex", "llmops-glm.config.toml"),
	codexProfileKrill: path.join(HOME, ".codex", "llmops-krill.config.toml"),
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

/** codex 可执行文件绝对路径:systemd user 服务的 PATH 不含 nvm/pi-node,需自行探测 */
function resolveCodexBin() {
	for (const dir of (process.env.PATH || "").split(":")) {
		if (!dir) continue;
		const p = path.join(dir, "codex");
		try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
	}
	const bases = [path.join(HOME, ".local/share/pi-node"), path.join(HOME, ".nvm/versions/node")];
	for (const base of bases) {
		try {
			const versions = fs.readdirSync(base).filter((d) => d.startsWith("node-") || d.startsWith("v")).sort().reverse();
			for (const v of versions) {
				const p = path.join(base, v, "bin", "codex");
				try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
			}
		} catch {}
	}
	return "codex"; // 兑底:交给 PATH
}
const CODEX_BIN = resolveCodexBin();

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

/** 解析 [model_providers.X] 表为对象(仅处理平铺键)。
 *  用逐行状态机而不是正则整体捕获:原实现 (?=^\[|\s*$) 的 lookahead 在 m 模式下
 *  于每个行尾都能满足 \s*$(\s 可跨行,但 $ 也能匹配行尾),惰性捕获在表头后第一行
 *  就截断,导致除第一个键(name)外 base_url/env_key/wire_api 等全部解析为空。 */
function tomlParseProviders(text) {
	const out = {};
	let cur = null;
	for (const line of text.split("\n")) {
		const head = line.match(/^\[model_providers\.([^"\]]+)\]\s*$/);
		if (head) {
			cur = head[1];
			if (!out[cur]) out[cur] = {}; // 同名表追加时保留先前键
			continue;
		}
		if (/^\s*\[/.test(line)) { cur = null; continue; } // 进入其他表,停止收集
		if (!cur) continue;
		const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*(?=#|$)/);
		if (!kv) continue;
		let v = kv[2].trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		else if (/^-?\d+$/.test(v)) v = Number(v);
		else if (v === "true" || v === "false") v = v === "true";
		else if (/^\[.*\]$/.test(v)) {
			try { v = JSON.parse(v); } catch { /* 非 JSON 兼容数组,保留原文 */ } // 双引号字符串数组与 JSON 语法兼容
		}
		out[cur][kv[1]] = v;
	}
	return out;
}

/** 定位 [model_providers.<id>] 表块区间(含表头,到下一个顶格 [ 表头前或文件尾) */
function findProviderBlock(text, id) {
	const head = text.match(new RegExp(`^\\[model_providers\\.${id}\\][ \\t]*$`, "m"));
	if (!head) return null;
	const start = head.index;
	const rest = text.slice(start + head[0].length);
	const next = rest.search(/^\[/m);
	return { start, end: next < 0 ? text.length : start + head[0].length + next };
}

/** 把 provider 键值对象渲染为 TOML 表块(尾部带空行分隔下一个表头) */
function renderProviderBlock(id, t) {
	const escToml = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const lines = [`[model_providers.${id}]`];
	const put = (k, v) => {
		if (v === undefined || v === "") return;
		if (Array.isArray(v)) { if (v.length) lines.push(`${k} = ${JSON.stringify(v)}`); return; } // TOML 字符串数组与 JSON 语法兼容
		lines.push(`${k} = ${typeof v === "string" ? `"${escToml(v)}"` : v}`);
	};
	put("name", t.name);
	put("base_url", t.base_url);
	put("env_key", t.env_key);
	put("requires_openai_auth", t.requires_openai_auth === undefined ? false : t.requires_openai_auth);
	put("request_max_retries", t.request_max_retries === undefined ? 3 : t.request_max_retries);
	put("stream_max_retries", t.stream_max_retries === undefined ? 10 : t.stream_max_retries);
	put("stream_idle_timeout_ms", t.stream_idle_timeout_ms === undefined ? 300000 : t.stream_idle_timeout_ms);
	put("wire_api", t.wire_api || "responses");
	// models 为 cockpit 扩展字段(codex 忽略):仅供面板展示与「设为默认」选择
	put("models", t.models);
	return lines.join("\n") + "\n\n";
}

/** 新 provider 块插入:最后一个 provider 表之后;一个都没有则插到第一个顶格表头之前 */
function insertProviderBlock(text, block) {
	let insertAt = -1;
	for (const id of Object.keys(tomlParseProviders(text))) {
		const b = findProviderBlock(text, id);
		if (b && b.end > insertAt) insertAt = b.end;
	}
	if (insertAt < 0) {
		const first = text.search(/^\[/m);
		if (first > 0 && text[first - 1] !== "\n") block = "\n" + block;
		insertAt = first < 0 ? text.length : first;
	}
	return text.slice(0, insertAt) + block + text.slice(insertAt);
}

/** 写盘前用 python3+toml 校验生成的 TOML(环境无 toml 包时跳过) */
async function validateTomlText(text) {
	const tmp = P.codexConfig + ".tmp-validate";
	await fsp.writeFile(tmp, text, "utf8");
	const r = await run("python3", ["-c", "import sys, toml; toml.load(sys.argv[1])", tmp]);
	await fsp.rm(tmp, { force: true });
	if ((r.stderr || "").includes("No module named")) return; // 环境没装 toml 包,不阻塞
	if (!r.ok) throw new Error("生成的 TOML 校验失败: " + ((r.stderr || r.error) || "").trim().slice(0, 300));
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

function listSkills(dir, source) {
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue; // 隐藏目录(codex 的 .system 内置 skills 等)不作展示/操作
		const full = path.join(dir, e.name);
		let isDir = false;
		try {
			isDir = fs.statSync(full).isDirectory(); // statSync 跟随软链(pi 的 ~/.agents/skills 里是软链)
		} catch {
			continue; // 失效链接等
		}
		const disabled = e.name.endsWith(".disabled");
		if (e.isFile() && e.name.endsWith(".md")) {
			const meta = parseSkillMd(full);
			const id = e.name.replace(/\.md(\.disabled)?$/, "");
			// id = 目录/文件名,停用/启用/删除的稳定标识;name = 显示名(frontmatter 优先,兜底 id)。
			// 注意 meta 必须先展开:SKILL.md 可能没有 name 字段(Claude Code 命令式 skill),
			// 若让 meta.name(空串)覆盖目录名,空 name 传到 manageSkill 会危及整个 skills 目录
			out.push({ ...meta, name: meta.name || id, id, dir: false, disabled, source });
		} else if (isDir) {
			const skillMd = path.join(full, "SKILL.md");
			if (fs.existsSync(skillMd)) {
				const meta = parseSkillMd(skillMd);
				const id = e.name.replace(/\.disabled$/, "");
				out.push({ ...meta, name: meta.name || id, id, dir: true, disabled, source });
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
	// 包清单以 settings.json 的 packages 为准(npm:xxx / git:xxx),再从安装目录读版本/描述
	const settings = await readJson(P.piSettings) || {};
	const out = [];
	for (const spec of settings.packages || []) {
		const m = String(spec).match(/^(npm|git):(.+)$/);
		const kind = m ? m[1] : "unknown";
		const name = m ? m[2] : String(spec);
		let installDir = null;
		if (kind === "npm") {
			installDir = path.join(P.piNpmDir, "node_modules", name);
		} else if (kind === "git") {
			// git 包装在 ~/.pi/agent/git/<host>/<user>/<repo>,逐层找 package.json
			const gitBase = path.join(HOME, ".pi", "agent", "git");
			try {
				outer: for (const d1 of fs.readdirSync(gitBase, { withFileTypes: true })) {
					if (!d1.isDirectory()) continue;
					const p1 = path.join(gitBase, d1.name);
					if (fs.existsSync(path.join(p1, "package.json"))) { installDir = p1; break; }
					for (const d2 of fs.readdirSync(p1, { withFileTypes: true })) {
						if (d2.isDirectory() && fs.existsSync(path.join(p1, d2.name, "package.json"))) {
							installDir = path.join(p1, d2.name);
							break outer;
						}
					}
				}
			} catch {}
		}
		const pkg = installDir ? await readJson(path.join(installDir, "package.json")) : null;
		out.push({ spec, name: pkg?.name || name, kind, version: pkg?.version || "", desc: (pkg?.description || "").slice(0, 120), installed: Boolean(pkg) });
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

/** codex marketplace 插件列表(解析 codex plugin list 的表格输出;version 空时列塌缩,末列恒为 path) */
async function listCodexPlugins() {
	const r = await run(CODEX_BIN, ["plugin", "list"], 30000);
	if (!r.ok) return [];
	return r.stdout.split("\n")
		.filter((l) => /^[^\s]+\s{2,}/.test(l) && !/^(PLUGIN|Marketplace|\/)/.test(l))
		.map((l) => {
			const cols = l.trim().split(/\s{2,}/);
			const last = cols.length - 1;
			return { plugin: cols[0] || "", status: cols[1] || "", version: cols.length > 3 ? cols[2] : "", path: cols[last] || "" };
		})
		.filter((p) => p.plugin.includes("@"));
}

/** codex MCP servers(取 codex mcp list 原始行,格式随版本变化不强解析) */
async function listCodexMcp() {
	const r = await run(CODEX_BIN, ["mcp", "list"], 30000);
	if (!r.ok) return [];
	return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/No MCP servers/i.test(l));
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
	// Pi 的 skills = 专属目录 + 共享目录(~/.agents/skills,pi 会同时读取)
	const piOwnSkills = listSkills(P.piSkillsDir, "专属");
	const sharedSkills = listSkills(P.sharedSkillsDir, "共享");
	state.agents.pi = {
		detected: fs.existsSync(P.piSettings),
		label: AGENTS.pi.label,
		settings: {
			defaultProvider: piSettings.defaultProvider || "",
			defaultModel: piSettings.defaultModel || "",
			theme: piSettings.theme || "",
		},
		providers: piProviders,
		skills: [...piOwnSkills, ...sharedSkills].sort((a, b) => a.name.localeCompare(b.name)),
		extensions: listPiExtensions(),
		packages: await listPiPackages(),
	};

	// Claude Code
	const claudeSettings = (await readJson(P.claudeSettings)) || {};
	const claudeProvStore = await readClaudeProviders();
	state.agents["claude-code"] = {
		detected: fs.existsSync(path.join(HOME, ".claude")),
		label: AGENTS["claude-code"].label,
		settings: {
			model: claudeSettings.model || "",
			envAnthropicBaseUrl: claudeSettings.env?.ANTHROPIC_BASE_URL || "",
			envAnthropicApiKeyMasked: maskKey(claudeSettings.env?.ANTHROPIC_API_KEY || ""),
			envAnthropicApiKeySet: Boolean(claudeSettings.env?.ANTHROPIC_API_KEY),
			envAnthropicAuthTokenMasked: maskKey(claudeSettings.env?.ANTHROPIC_AUTH_TOKEN || ""),
			envAnthropicAuthTokenSet: Boolean(claudeSettings.env?.ANTHROPIC_AUTH_TOKEN),
		},
		providers: Object.entries(claudeProvStore.providers).map(([id, p]) => ({
			id,
			baseUrl: p.baseUrl || "",
			model: p.model || "",
			authStyle: p.authStyle === "api-key" ? "api-key" : "bearer",
			apiKeyMasked: maskKey(p.apiKey || ""),
			apiKeySet: Boolean(p.apiKey),
		})),
		skills: listSkills(P.claudeSkillsDir, "专属"),
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
			name: t.name || "",
			baseUrl: t.base_url || "",
			envKey: t.env_key || "",
			wireApi: t.wire_api || "",
			models: Array.isArray(t.models) ? t.models : [],
		})),
		auth: {
			mode: codexAuth.auth_mode || "",
			apiKeyMasked: maskKey(codexAuth.OPENAI_API_KEY || ""),
			apiKeySet: Boolean(codexAuth.OPENAI_API_KEY),
		},
		skills: listSkills(P.codexSkillsDir, "Codex"),
		plugins: await listCodexPlugins(),
		mcp: await listCodexMcp(),
	};
	// codex profile 叠加文件(哪些 provider 已生成 /model 配置)
	const codexProfiles = [];
	try {
		for (const f of fs.readdirSync(path.join(HOME, ".codex"))) {
			if (!f.endsWith(".config.toml")) continue;
			const t = fs.readFileSync(path.join(HOME, ".codex", f), "utf8");
			const mp = t.match(/^model_provider\s*=\s*"([\w-]+)"/m);
			if (mp) codexProfiles.push({ file: f, provider: mp[1] });
		}
	} catch {}
	state.agents.codex.profiles = codexProfiles;

	// 共享 skills(pi 侧已合并展示,这里保留供单独查看)
	state.shared.skills = sharedSkills;

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

/** 把前端传入的模型列表(逗号/空白分隔的字符串或数组)规范化为 models.json 的 models 数组。
 *  pi 只要求 model.id 必填,其余字段(name/contextWindow/cost 等)有内置默认值;
 *  已存在的同名模型保留原完整定义,避免覆盖手工调过的参数。 */
function normalizePiModels(input, prev) {
	const ids = [...new Set((Array.isArray(input) ? input : String(input).split(/[,,，\s;、]+/)).map((s) => s.trim()).filter(Boolean))];
	const prevList = Array.isArray(prev) ? prev : [];
	return ids.map((id) => {
		const hit = prevList.find((m) => m && m.id === id);
		return hit ? { ...hit, id } : { id };
	});
}

/** models.json provider 增改删;newKey 为空表示不修改 apiKey;models 传空串表示清空模型列表 */
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
		if (data.newApiKey !== undefined) {
			if (data.newApiKey === "none") delete next.apiKey;
			else if (data.newApiKey) next.apiKey = data.newApiKey;
		}
		if (data.models !== undefined) next.models = normalizePiModels(data.models, cur.models);
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
	for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
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

/** Claude Code 原生无多 provider 概念(仅 settings.json 里单份 env.ANTHROPIC_BASE_URL/API_KEY),
 *  这里自管配方列表 ~/.agent-cockpit/claude-providers.json(含明文 key,权限 0600);
 *  apply = 把配方写入 settings.json。首次初始化时从 pi models.json 导入 anthropic-messages 协议的 provider。 */
async function readClaudeProviders() {
	let list = await readJson(P.claudeProviders);
	if (!list) {
		list = { providers: {} };
		try {
			const pi = (await readJson(P.piModels)) || {};
			for (const [id, p] of Object.entries(pi.providers || {})) {
				if (p.api !== "anthropic-messages" || !p.baseUrl) continue;
				if (!/^[\w-]+$/.test(id)) continue;
				list.providers[id] = {
					baseUrl: p.baseUrl,
					apiKey: p.apiKey || "",
					model: (p.models || []).map((m) => m.id)[0] || "",
					authStyle: "bearer", // pi 的 anthropic-messages 用 Authorization 头(pi models.json authHeader:true)
				};
			}
		} catch {}
		await writeJsonSafe(P.claudeProviders, list);
		await fsp.chmod(P.claudeProviders, 0o600).catch(() => {});
	}
	if (!list.providers) list.providers = {};
	return list;
}

/** claude provider 配方增改删 + apply(把配方写入 settings.json 的 env/model);返回 apply 结果或 null */
async function saveClaudeProvider(action, data) {
	const store = await readClaudeProviders();
	store.providers = store.providers || {};
	if (action === "delete") {
		if (!store.providers[data.id]) throw new Error("未找到: " + data.id);
		delete store.providers[data.id];
	} else if (action === "create" || action === "update") {
		const id = String(data.id || "").trim();
		if (!/^[\w-]+$/.test(id)) throw new Error("无效的 provider id: " + JSON.stringify(id || ""));
		const cur = store.providers[id] || {};
		const next = { ...cur };
		if (data.baseUrl !== undefined) next.baseUrl = String(data.baseUrl).trim();
		if (data.model !== undefined) next.model = String(data.model).trim();
		if (data.authStyle !== undefined) next.authStyle = ["bearer", "api-key"].includes(data.authStyle) ? data.authStyle : "bearer";
		if (data.newApiKey !== undefined) {
			if (data.newApiKey === "none") delete next.apiKey;
			else if (data.newApiKey) next.apiKey = String(data.newApiKey);
		}
		if (action === "create" && !next.baseUrl) throw new Error("base_url 不能为空");
		store.providers[id] = next;
	} else if (action === "apply") {
		const p = store.providers[String(data.id || "").trim()];
		if (!p) throw new Error("未找到: " + data.id);
		if (!p.baseUrl) throw new Error(`配方「${data.id}」缺 base_url,请先编辑`);
		// Claude Code 在 BASE_URL 后自动拼 /v1/messages:pi 格式的 baseUrl 带 /v1,应用时去掉(已按 claude 习惯填的不受影响)
		const baseUrl = String(p.baseUrl).replace(/\/v1\/?$/, "");
		// 认证方式:bearer → ANTHROPIC_AUTH_TOKEN(Authorization: Bearer 头);api-key → ANTHROPIC_API_KEY(x-api-key 头)。
		// llmops 网关实测只认 Bearer(x-api-key 返回 Authorization required)。key 为空的配方只切网关不动现有 key(避免误清 auth)
		const keyField = p.authStyle === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
		const values = { ANTHROPIC_BASE_URL: baseUrl, [keyField === "ANTHROPIC_AUTH_TOKEN" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]: "" };
		if (p.apiKey) values[keyField] = p.apiKey;
		if (p.model) values.model = p.model;
		await saveClaudeSettings(values);
		return { id: String(data.id).trim(), baseUrl, model: p.model || "", keyField };
	} else {
		throw new Error("未知操作: " + action);
	}
	await writeJsonSafe(P.claudeProviders, store);
	await fsp.chmod(P.claudeProviders, 0o600).catch(() => {});
	return null;
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

/** codex [model_providers.X] 增改删。key 通过 env_key 指向环境变量(不走 auth.json 的 key 时),
 *  环境变量本身由用户写入 shell rc,面板不代管。返回引用了该 provider 的 profile 叠加文件列表。 */
async function saveCodexProvider(action, data) {
	let text = "";
	try {
		text = await fsp.readFile(P.codexConfig, "utf8");
	} catch {
		throw new Error("未找到 ~/.codex/config.toml");
	}
	const id = String(data.id || "").trim();
	if (!/^[\w-]+$/.test(id)) throw new Error("无效的 provider id: " + JSON.stringify(id || ""));
	const block = findProviderBlock(text, id);
	if (action === "delete") {
		if (!block) throw new Error("未找到 provider: " + id);
		if (tomlGetTop(text, "model_provider") === id) throw new Error(`「${id}」是当前默认 provider(model_provider),请先切换默认后再删除`);
		text = text.slice(0, block.start) + text.slice(block.end);
	} else if (action === "create" || action === "update") {
		const cur = block ? tomlParseProviders(text)[id] || {} : {};
		if (action === "create" && block) throw new Error("已存在: " + id);
		const next = { ...cur };
		if (data.name !== undefined) next.name = String(data.name).trim();
		if (data.baseUrl !== undefined) next.base_url = String(data.baseUrl).trim();
		if (data.envKey !== undefined) next.env_key = String(data.envKey).trim(); // 空串 = 移除 env_key,改用 auth.json
		if (data.wireApi !== undefined) {
			const w = String(data.wireApi).trim();
			// codex 0.146+ 已弃用 chat wire(实测报错指向 codex discussion 7782),只接受 responses
			if (w !== "responses") throw new Error("wire_api 只支持 responses(codex 0.146+ 已弃用 chat)");
			next.wire_api = w;
		}
		if (data.models !== undefined) {
			const list = Array.isArray(data.models)
				? data.models
				: String(data.models).split(/[,,，\s;、]+/); // 与 pi normalizePiModels 同分隔符(含中文逗号/顿号)
			next.models = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
			if (!next.models.length) delete next.models; // 清空 = 删除字段
		}
		if (!next.base_url) throw new Error("base_url 不能为空");
		const rendered = renderProviderBlock(id, next);
		text = block
			? text.slice(0, block.start) + rendered + text.slice(block.end)
			: insertProviderBlock(text, rendered);
	} else {
		throw new Error("未知操作: " + action);
	}
	await validateTomlText(text);
	await writeFileSafe(P.codexConfig, text);
	// profile 叠加文件若 model_provider 指向该 provider,删除/改名后会悬空,提醒用户
	const warnings = [];
	try {
		for (const f of fs.readdirSync(path.join(HOME, ".codex"))) {
			if (!f.endsWith(".config.toml")) continue;
			const t = fs.readFileSync(path.join(HOME, ".codex", f), "utf8");
			if (new RegExp(`^model_provider\\s*=\\s*"${id}"`, "m").test(t)) warnings.push(f);
		}
	} catch {}
	return warnings;
}

/** 从 provider 的 models 列表一键生成 /model 配置(vcgw/llmops 模式):
 *  model-catalogs/<id>.json(catalog 条目从本机 vcgw.json 模板派生)+ <id>.config.toml profile 叠加文件。 */
async function generateCodexProfileBundle(id) {
	const text = await fsp.readFile(P.codexConfig, "utf8").catch(() => { throw new Error("未找到 ~/.codex/config.toml"); });
	const p = tomlParseProviders(text)[id];
	if (!p) throw new Error("未找到 provider: " + id);
	const models = Array.isArray(p.models) ? p.models : [];
	if (!models.length) throw new Error(`provider「${id}」还没有模型列表,请先点「改模型」填写`);
	const tplFile = await readJson(path.join(HOME, ".codex", "model-catalogs", "vcgw.json"));
	const tpl = tplFile && Array.isArray(tplFile.models) && tplFile.models.length ? tplFile.models[0] : null;
	if (!tpl) throw new Error("未找到 catalog 模板 ~/.codex/model-catalogs/vcgw.json");
	const catPath = path.join(HOME, ".codex", "model-catalogs", id + ".json");
	const entries = models.map((slug) => {
		const e = JSON.parse(JSON.stringify(tpl));
		e.slug = slug;
		e.display_name = `${slug} (${p.name || id})`;
		e.description = `${slug} via ${p.base_url || id}`;
		e.context_window = /\[1m\]$/i.test(slug) ? 1000000 : 272000; // [1m] 后缀 = 1M 上下文变体
		e.input_modalities = /glm/i.test(slug) ? ["text"] : (Array.isArray(e.input_modalities) ? e.input_modalities : ["text"]);
		return e;
	});
	await fsp.mkdir(path.dirname(catPath), { recursive: true });
	await writeJsonSafe(catPath, { models: entries });
	const profilePath = path.join(HOME, ".codex", id + ".config.toml");
	await writeFileSafe(profilePath, [
		`# profile: ${p.name || id} — 用法: codex --profile ${id}`,
		`# provider 定义在基础 config.toml [model_providers.${id}]`,
		`model = ${JSON.stringify(models[0])}`,
		`model_provider = ${JSON.stringify(id)}`,
		`model_catalog_json = ${JSON.stringify(catPath)}`,
		"",
	].join("\n"));
	return { catalog: catPath, profile: profilePath, models, usage: `codex --profile ${id}` };
}

// skills / 扩展管理
function skillDirsFor(agent) {
	if (agent === "pi") return [P.piSkillsDir, P.sharedSkillsDir]; // pi 两个目录都会加载
	if (agent === "claude-code") return [P.claudeSkillsDir];
	if (agent === "codex") return [P.codexSkillsDir];
	if (agent === "shared") return [P.sharedSkillsDir];
	return [];
}

async function manageSkill(agent, action, name) {
	const dirs = skillDirsFor(agent);
	if (!dirs.length) throw new Error("未知 agent: " + agent);
	// 校验 name:空串会让 path.join(dir, "") 直接返回 skills 根目录,导致 disable 把整个
	// skills 目录改名、delete 整个删光(2026-09-20 事故根因:SKILL.md 无 name 字段时列表项 name 为空)
	if (!name || !/^[\w][\w.-]*$/.test(name)) throw new Error("无效的 skill 名称: " + JSON.stringify(name || ""));
	const findEntry = () => {
		for (const dir of dirs) {
			for (const cand of [name, name + ".disabled", name + ".md", name + ".md.disabled"]) {
				const p = path.join(dir, cand);
				if (p === dir) continue; // 双保险:绝不把 skills 根目录本身当作操作目标
				if (fs.existsSync(p)) return p;
			}
		}
		return null;
	};
	switch (action) {
		case "delete": {
			const target = findEntry();
			if (!target) throw new Error("未找到: " + name);
			await fsp.rm(target, { recursive: true, force: true });
			return { deleted: target };
		}
		case "disable": {
			const target = findEntry();
			if (!target) throw new Error("未找到: " + name);
			if (target.endsWith(".disabled")) throw new Error("已是停用状态");
			const dest = target + ".disabled";
			await fsp.rename(target, dest);
			return { disabled: dest };
		}
		case "enable": {
			const target = findEntry();
			if (!target) throw new Error("未找到: " + name);
			if (!target.endsWith(".disabled")) throw new Error("已是启用状态");
			await fsp.rename(target, target.slice(0, -".disabled".length));
			return { enabled: name };
		}
		case "create": {
			const skillDir = path.join(dirs[0], name);
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
		if ((m = route.match(/^\/api\/agent\/codex\/providers?$/)) && (req.method === "POST" || req.method === "PUT")) {
			const body = await readBody(req);
			let result;
			if (body.action === "gen-profile") result = { bundle: await generateCodexProfileBundle(String(body.id || "")) };
			else result = { profileRefs: await saveCodexProvider(body.action || "update", body) };
			return json(res, 200, { ok: true, ...result });
		}
		if ((m = route.match(/^\/api\/agent\/codex\/mcp$/)) && req.method === "POST") {
			const body = await readBody(req);
			const name = String(body.name || "").trim();
			if (!/^[\w-]+$/.test(name)) throw new Error("无效的 MCP server 名称: " + JSON.stringify(name || ""));
			let r;
			if (body.action === "add") {
				const cmd = String(body.command || "").trim();
				if (!cmd) throw new Error("启动命令不能为空");
				r = await run(CODEX_BIN, ["mcp", "add", name, "--", ...cmd.split(/\s+/)], 60000);
			} else if (body.action === "remove") {
				r = await run(CODEX_BIN, ["mcp", "remove", name], 30000);
			} else {
				throw new Error("未知操作: " + body.action);
			}
			if (!r.ok) throw new Error((r.stderr || r.stdout || "codex mcp " + body.action + " 失败").trim());
			return json(res, 200, { ok: true, output: (r.stdout || r.stderr || "").trim() });
		}
		if ((m = route.match(/^\/api\/agent\/claude-code\/providers?$/)) && (req.method === "POST" || req.method === "PUT")) {
			const body = await readBody(req);
			const applied = await saveClaudeProvider(body.action || "update", body);
			return json(res, 200, { ok: true, ...(applied ? { applied } : {}) });
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
				{ id: "pi-auth", label: "Pi 登录凭据", path: P.piAuth, lang: "json" },
				{ id: "claude-settings", label: "Claude Code 设置", path: P.claudeSettings, lang: "json" },
				{ id: "codex-config", label: "Codex 配置 (TOML)", path: P.codexConfig, lang: "toml" },
				{ id: "codex-auth", label: "Codex 认证 (auth.json)", path: P.codexAuth, lang: "json" },
				{ id: "codex-profile-glm", label: "Codex Profile llmops-glm (TOML)", path: P.codexProfileGlm, lang: "toml" },
				{ id: "codex-profile-krill", label: "Codex Profile llmops-krill (TOML)", path: P.codexProfileKrill, lang: "toml" },
			].filter((f) => fs.existsSync(f.path));
			return json(res, 200, { files });
		}
		if (route === "/api/files/read" && req.method === "POST") {
			const body = await readBody(req);
			const known = [P.agentNotifyConf, P.piSettings, P.piModels, P.claudeSettings, P.codexConfig, P.codexAuth, P.codexProfileGlm, P.codexProfileKrill];
			if (!known.includes(body.path)) return json(res, 403, { error: "只允许读取白名单内的配置文件" });
			const content = await fsp.readFile(body.path, "utf8");
			return json(res, 200, { content });
		}
		if (route === "/api/files/write" && req.method === "POST") {
			const body = await readBody(req);
			const known = [P.agentNotifyConf, P.piSettings, P.piModels, P.claudeSettings, P.codexConfig, P.codexAuth, P.codexProfileGlm, P.codexProfileKrill];
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
