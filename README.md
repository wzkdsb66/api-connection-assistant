# API 连接助手（SillyTavern 扩展）

一个站在酒馆 1.18 自带 `Connection Profiles` 之上的增强层：悬浮快切、API 面板入口、不切换连接的一键测试。

## 版本要求

- SillyTavern `1.18.0` 或更高
- 必须启用内置 `Connection Profiles` 扩展（连接档案的真正存档/读档由它负责）
- 本插件不新建密钥库、不存储密钥、不导出密钥、不联网上报数据

## 安装（推荐：酒馆内一键安装）

在酒馆「扩展 → Manage Extensions → Install extension」里填入：

`	ext
https://github.com/wzkdsb66/api-connection-assistant
` 

## 安装（手动复制）

把整个 `api-connection-assistant` 文件夹复制到你的酒馆扩展目录，二选一：

- 用户作用域：`data/<你的用户名>/extensions/api-connection-assistant/`
- 全局作用域：`public/scripts/extensions/third-party/api-connection-assistant/`

然后重启酒馆（或刷新浏览器），在「扩展」面板中确认 `API 连接助手` 已启用。

## 使用

1. 先在酒馆自带 `Connection Profiles` 里创建至少一个连接档案。
2. 打开「扩展 → API 连接助手」：
   - 勾选「启用悬浮快切窗」会在右侧出现 ⚡ 悬浮球，点档案名即切换。
   - 点「测试」会用该档案发一个 1 token 的最小请求，显示延迟与结果。
3. API 连接面板里也会出现「API 连接助手」入口，可下拉选择档案并切换/测试。

## 验收清单

- [ ] 扩展面板中出现「API 连接助手」，且能看到自带连接档案列表
- [ ] 悬浮窗开关生效；点档案名能切换，顶部连接状态同步变化
- [ ] API 面板入口出现；下拉选择 + 切换生效
- [ ] 对一个可用档案点「测试」显示绿色 ✓ 和延迟
- [ ] 对一个故意填错的档案点「测试」显示红色 ✗ 和失败原因
- [ ] 刷新页面后，悬浮窗开关状态与测试结果仍在（本机持久化）
- [ ] 禁用扩展后，悬浮球、悬浮窗、API 面板入口、扩展设置块都消失

## 边界说明

- 测试走酒馆自带的 `ConnectionManagerRequestService`，不绕过 CORS，也不读取密钥明文。
- 若某服务商不支持 1 token 请求，测试可能失败，但不代表日常聊天不可用；请以实际生成一次为准。
- 本版本不提供「拉取模型列表」：1.18 的连接服务只能发对话请求，拿不到服务商完整模型清单。

