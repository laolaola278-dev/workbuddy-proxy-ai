# WorkBuddy Cline Proxy

本目录按同级 `qoder-proxy` 的思路做成一个**仅监听本机**的 Cline 适配层：

- 暴露 WorkBuddy 研究目录中整理出的模型清单；
- 提供 OpenAI 兼容接口：`/v1/models`、`/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`；
- 提供 Anthropic 兼容接口：`/v1/messages`；
- 支持 SSE 流式转发；
- 支持 `MODEL_MAP_JSON` 将 WorkBuddy 模型 ID 映射到实际上游模型 ID；
- 默认不包含任何账号、Token 或私有上游地址。

> 目前从解包代码中已经确认了本地模型配置和自定义 OpenAI 模型格式，但 WorkBuddy 内置模型的真实云端推理请求仍需要在登录态下抓取确认。因此这个版本先把 Cline 接口和模型目录稳定暴露出来，真正的上游通过环境变量配置，不绕过登录、计费或访问控制。

## 启动

```powershell
cd .\workbuddy-cline-proxy
Copy-Item .env.example .env
# 编辑 .env，至少设置 UPSTREAM_BASE_URL
npm start
# 或双击 start-proxy.cmd
```

默认监听：

```text
http://127.0.0.1:8964
```

健康检查：

```powershell
curl http://127.0.0.1:8964/health
curl http://127.0.0.1:8964/v1/models
```

## 配置上游

### OpenAI 兼容上游

```dotenv
UPSTREAM_BASE_URL=http://127.0.0.1:8000/v1
UPSTREAM_API_KEY=your-upstream-key
UPSTREAM_PROTOCOL=openai
MODEL_MAP_JSON={"deepseek-v4-pro":"deepseek-chat"}
```

`UPSTREAM_BASE_URL` 可以填写根地址或带 `/v1` 的地址，代理会自动请求 `/chat/completions`、`/images/generations` 或 `/images/edits`。

### 按模型路由到不同上游

WorkBuddy 的自定义模型经常指向多个上游。设置 `MODEL_ROUTES_PATH` 后，请求里的模型 ID 命中路由表时走对应的地址和密钥，未命中的模型仍走上面的单一上游：

```dotenv
MODEL_ROUTES_PATH=%USERPROFILE%\.workbuddy\models.json
```

文件格式兼容 WorkBuddy 自己的 `models.json`，即 `[{ "id": "deepseek-v4-flash", "url": "https://example.invalid/v1/chat/completions", "apiKey": "..." }]`。代理启动时读取一次，不打印其中的密钥，也不把该文件复制进项目目录。命中路由的模型 ID 原样转发给上游，不再套用 `MODEL_MAP_JSON`。

配置了路由表后，`GET /v1/models` 只返回这些可转发的模型，避免客户端选到没有上游的内置模型。未配置路由表时仍返回完整的 `models.json` 目录。`start-proxy.cmd` 在未显式设置 `MODEL_ROUTES_PATH` 时，会自动使用 `%USERPROFILE%\.workbuddy\models.json`。

### Anthropic 上游

```dotenv
UPSTREAM_BASE_URL=https://example.invalid/v1
UPSTREAM_API_KEY=your-upstream-key
UPSTREAM_PROTOCOL=anthropic
```

此模式下 `/v1/messages` 会直接转发；Cline 如果走 OpenAI 协议，请保持 `UPSTREAM_PROTOCOL=openai`。

## Cline 配置

在 Cline 的自定义 OpenAI 兼容提供商中填写：

- **Base URL**：`http://127.0.0.1:8964/v1`
- **API Key**：如果 `.env` 设置了 `PROXY_API_KEY`，这里填同一个值；否则可填任意值
- **Model**：例如 `deepseek-v4-pro`、`glm-5.1`、`kimi-k2.5`

如果 Cline 走 Anthropic 兼容模式：

- **Base URL**：`http://127.0.0.1:8964`
- **API Key**：同上
- **Model**：使用 `models.json` 中的模型 ID


Cline 的 OpenAI-compatible image model 可使用 `POST /v1/images/generations` 或 multipart `POST /v1/images/edits`；代理会保留标准字段、按 `MODEL_MAP_JSON` 重写模型 ID，并转发图像文件内容。

## 安全边界

- 只绑定 `127.0.0.1`；
- `/v1/*` 可通过 `PROXY_API_KEY` 开启本机客户端认证；
- `.env` 不应提交到版本库；
- 代理不会自动提取、复用或打印 WorkBuddy / Qoder 的登录凭据；
- 未配置 `UPSTREAM_BASE_URL` 时，模型列表仍可用，但推理请求会返回 `upstream_not_configured`。

## 模型目录

`models.json` 来自同级 `workbuddy-research/models.md` 的 44 个模型记录。后续抓到真实远端模型目录后，只需要替换该文件，不需要改代理协议层。


## Editions

`WORKBUDDY_EDITION` selects the built-in model list:

- `domestic`: `hy3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `hy4-preview`
- `international`: `hy4-preview-f`, `deepseek-v4.1-flash`

Set `WORKBUDDY_CLI_PATH` to that edition's unpacked `codebuddy` CLI. Built-in requests use the desktop-hosted CLI session and are billed normally. `.env` and `models.json` route keys stay local and are not part of this repository.

## Compatibility tuning

The proxy removes SDK-only `verbosity` and `reasoning_summary` fields by default, while keeping `reasoning_effort` for custom OpenAI-compatible models. Adjust these behaviors in `.env`:

```dotenv
UPSTREAM_STRIP_VERBOSITY=true
UPSTREAM_STRIP_REASONING_SUMMARY=true
UPSTREAM_STRIP_REASONING_EFFORT=false
UPSTREAM_MAX_TOKENS_FIELD=passthrough
UPSTREAM_THINKING_FORMAT=openai
```

`UPSTREAM_MAX_TOKENS_FIELD` accepts `passthrough`, `auto`, `max_tokens`, or `max_completion_tokens`. `UPSTREAM_THINKING_FORMAT` accepts `openai`, `auto`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, or `qwen-chat-template`.

### 流式空闲超时

`REQUEST_TIMEOUT_MS` 只覆盖到上游响应头到达为止。响应头之后如果上游长时间不再吐字节，由 `STREAM_IDLE_TIMEOUT_MS` 兜底（默认 120000，设为 0 关闭）：流式转发会在空闲到期时结束本次响应并回收上游连接，非流式缓冲读取则返回 `504 upstream_timeout`。代理在这两种情况下都会保持存活，不会因单条断流挂掉整个进程。

### Cline custom headers

Cline 的 OpenAI-Compatible provider 支持自定义 headers。代理默认不盲目转发入站 headers；如需将 Cline 配置的非敏感 headers 传给上游，在 `.env` 中显式配置 allowlist：

```dotenv
FORWARD_REQUEST_HEADERS=HTTP-Referer,X-Title,X-Provider-Trace
```

只会转发 allowlist 中的 header；`Authorization`、`Cookie`、`Host`、`Content-Type`、`Accept` 等敏感或由代理控制的 transport headers 始终不会从入站请求复制到上游。上游认证仍以 `UPSTREAM_API_KEY` 为准。
