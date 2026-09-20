# agent-cockpit

**多 Agent 统一管理面板** —— 一个本地 Web 页面,管理 Claude Code / Pi / Codex 的通知、模型、API Key、Base URL、Skills、插件与扩展。

配合 [agent-notify](../agent-notify) 使用(通知配置委托其核心,行为与 CLI 完全一致)。

## 快速开始

```bash
./install.sh          # 安装 agent-cockpit 命令到 ~/.local/bin
agent-cockpit         # 启动并打开浏览器(http://127.0.0.1:8621)
```

其它命令:`agent-cockpit stop | status | serve(前台调试) | restart`。

依赖:Node.js(有 pi 就有;启动器会自动找 pi 自带的 node)。零 npm 依赖。

## 功能

### 📡 总览
每个 agent 一张卡片:检测状态、当前模型、Skills 数量、通知开关;一键「测试通知」、一键静音/恢复某个 agent 的通知。

### 🔔 通知(agent-notify)
- 五条通道开关(本机音效 / 桌面弹窗 / 终端 OSC / Bark 推送 / WLED 灯带)+ 各通道参数(Bark key、灯带 IP、音效文件)
- 提醒策略:任务完成提醒的最短时长(`min_task_seconds`)
- 按 agent 静音/恢复(对应配置里的 `agents=`)
- 模式快捷切换(phone / local / all / off)
- 按 agent 发送测试通知,逐通道显示 ✓/✗ 报告
- 保存只改动有变化的项,立即生效,无需重启任何 agent

### 🤖 模型与密钥
| Agent | 可管理 |
|---|---|
| Claude Code | `model`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`(settings.json env) |
| Pi | `defaultProvider` / `defaultModel`;models.json 自定义 Provider(增/改 Key/删);一键「设为默认」 |
| Codex | `model` / `model_provider`(config.toml 顶层键);auth.json 的 API Key;Provider 表(只读展示) |

API Key 一律不回显明文,只显示掩码;留空 = 不修改。

### 🧩 Skills
Claude Code / Pi / 共享 `~/.agents/skills` 三组:列表(读 SKILL.md 元数据)、按名称过滤、从模板创建、停用/启用(目录改名 `.disabled`)、删除。

### 🧱 插件与扩展
Pi 扩展列表(可删除,删除前自动备份)、Pi npm/git 包展示;Claude Code 插件展示(启停请用 `/plugin`);Codex 无插件系统。

### 📝 配置文件
所有 managed 配置文件的原始编辑(通知 conf、Pi settings/models、Claude settings、Codex TOML),保存前自动备份 `*.bak-cockpit`,JSON 先校验再落盘。

## 安全说明

- 服务只绑定 `127.0.0.1`,不监听外网
- 所有配置写入先滚动备份为 `*.bak-cockpit`,再原子替换(tmp + rename)
- API Key 不会在页面/接口中回显明文
- 原始文件编辑有白名单,只能读写列出的配置文件

## 项目结构

```
agent-cockpit/
├── bin/agent-cockpit     # 启动器(start/stop/status/serve,自动找 node)
├── server/server.js      # HTTP + API(零依赖 Node,绑定 127.0.0.1)
└── web/index.html        # 单文件前端(原生 HTML/CSS/JS,无构建)
```

## 常见问题

**端口被占用?** 设 `COCKPIT_PORT=xxxx agent-cockpit` 换端口;或服务已在运行时直接访问原地址。

**改了模型不生效?** Claude Code / Pi 的模型在**新会话**生效;Codex 需重启。

**通知设置和 agent-notify CLI 是一套吗?** 是,页面保存实际调用 `~/.agent-notify/core/notify.sh set`,与命令行完全等价。

## 许可

[MIT](LICENSE)
