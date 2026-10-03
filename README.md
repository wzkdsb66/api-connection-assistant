# API 连接助手（SillyTavern 扩展）

按「站点」管理 API 连接：名称 + 网址 + 密钥 + 模型列表整体保存，一键切换。切换只改 API 连接，不动补全预设。界面为淡蓝色毛玻璃质感。

## 版本要求

- SillyTavern `1.18.0` 或更高
- 密钥写入酒馆原生密钥库（`api_key_custom` 命名槽位），同时保存在本机扩展数据中
- 不联网上报数据、不随角色卡导出

## 安装

酒馆「扩展 → Manage Extensions → Install extension」粘贴：

```text
https://github.com/wzkdsb66/api-connection-assistant
```

## 站点管理

每个站点包含：

- **名称**：方便识别，例如「白天主力站」
- **API URL**：例如 `https://example.com/v1`
- **API Key**：可填多个（换行 / 逗号分隔），第一个为默认；点钥匙按钮在多把钥匙之间轮换切换
- **模型 ID**：可填多个（换行 / 逗号分隔），第一个为默认；也可以点「获取模型」从站点拉取真实模型列表
- **分组**：给站点分类，顶部可按分组筛选

站点卡片上：点**模型行**直接切换到该模型；按钮分别是 **使用**（应用整个站点）、**模型**（获取 / 刷新模型列表）、**钥匙**（轮换下一把密钥）、**编辑**、**删除**，最右侧 **↑ ↓** 调整排序。

## 排序

- 顺序完全由你决定：卡片上的 **↑ / ↓** 按钮即调即存，刷新、重启酒馆后保持。
- 新站点追加在列表末尾；导入的站点同样排在末尾。
- 分组筛选只影响显示，不会打乱你排好的顺序。

## 使用统计

- 每次用本插件连接成功后开始生成，酒馆报「生成结束」时，给当前站点记 1 次使用，并更新「最近使用」时间。
- 统计只写在本机扩展数据里，不参与排序，可点「重置使用统计」一键清零。

## 悬浮快切窗

- 在设置里勾选「启用悬浮快切窗」后出现 ⚡ 球；球和窗口**都可以拖动**，位置自动记忆。
- 点站点名切换；点「模」展开模型按钮，点具体模型即切换。
- 勾选「使用站点后自动同步到快切窗」后，每次切换都会高亮当前站点。

## 界面语言

- 扩展设置面板里可选：**跟随酒馆 / 中文 / English**，选择即时生效并记住。
- 语言文件是 `i18n/zh-cn.json` 和 `i18n/en.json`；万一文件加载失败，界面会退化为词条键名，功能不受影响。

## 切换时到底改了什么

按顺序执行（全部是酒馆官方命令）：`/api custom → /secret-id → /api-url → /model`。

不会改动：补全预设、系统提示、上下文模板、正则、世界书等任何生成设置。

## 关于「测试」

本插件**没有**任何测试功能，不会发送消耗额度的请求。唯一的网络请求是你主动点「获取模型」时对 `<站点URL>/models` 的一次拉取。

## 导入 / 导出

- 导出：把站点列表保存成 JSON 文件。默认**不含密钥**；勾选「导出时包含密钥」后会把密钥一并写入文件（请妥善保管）。
- 导入：选择之前导出的 JSON，按「名称 + URL」合并，同名同址的站点会更新，其余新增。

## 边界说明

- 获取模型是浏览器直接请求站点；若站点禁止跨域（CORS）会失败，可手动填写模型 ID。
- 面向 OpenAI 兼容端点（`/v1` 风格）；连接逻辑走适配器层（`openai-compatible`），Claude / Gemini 官方接口不在支持范围。

---

# API Connection Assistant (SillyTavern Extension)

Manage API connections as *sites*: name + URL + key + model list saved together and switched in one click. Switching only changes the API connection and never touches completion presets. The UI uses a frosted light-blue glass style.

## Requirements

- SillyTavern `1.18.0` or newer
- Keys are written to SillyTavern's native secret store (`api_key_custom` slot) and also kept in the extension's local data
- Nothing is reported online and nothing rides along with character cards

## Install

In SillyTavern: **Extensions → Manage Extensions → Install extension**, then paste:

```text
https://github.com/wzkdsb66/api-connection-assistant
```

## Sites

Each site holds:

- **Name** – e.g. "Main daytime site"
- **API URL** – e.g. `https://example.com/v1`
- **API Key** – multiple allowed (newline / comma separated); the first is the default. The key button rotates between them
- **Model IDs** – multiple allowed; the first is the default. Use **Fetch models** to pull the real list from the site
- **Group** – categorize sites; filter by group at the top

Card actions: click a **model row** to switch straight to it; buttons are **Use**, **Models** (fetch / refresh), **Key** (rotate), **Edit**, **Delete**, plus **↑ ↓** to reorder.

## Custom Sorting

- The order is entirely yours: **↑ / ↓** on each card saves immediately and survives reloads and restarts.
- New sites (and imported ones) are appended to the end.
- Group filtering only changes what is displayed; it never reorders your list.

## Usage Stats

- After a site is applied and a generation finishes, the active site gains one usage count and a fresh "last used" timestamp.
- Stats live only in the extension's local data, never affect sorting, and can be cleared with **Reset usage stats**.

## Floating Quick-Switch Window

- Enable it in settings to get the ⚡ ball. Both the ball and the window are **draggable**, with positions remembered.
- Click a site name to switch; click "模" to expand model chips and click a model to switch to it.

## Interface Language

- Choose **Follow SillyTavern / 中文 / English** in the settings panel; the change applies instantly and is remembered.
- Language files are `i18n/zh-cn.json` and `i18n/en.json`. If they fail to load, the UI falls back to key names while all functionality keeps working.

## What Switching Actually Changes

Four official commands in order: `/api custom → /secret-id → /api-url → /model`.

It never changes completion presets, system prompts, context templates, regexes, or world info.

## No Testing Feature

There is **no** test function anywhere in this extension, so it never sends requests that cost you quota. The only network request is the `<siteURL>/models` fetch you trigger yourself with **Fetch models**.

## Import / Export

- Export writes the site list to a JSON file. Keys are **excluded** by default; check "Include keys when exporting" to embed them (keep the file safe).
- Import merges by name + URL: matching sites are updated, the rest are added.

## Boundaries

- Fetching models is a direct browser request to your site; if the site blocks CORS it will fail and you can type model IDs manually.
- The connection logic goes through an adapter layer (`openai-compatible`); Claude / Gemini official APIs are out of scope.