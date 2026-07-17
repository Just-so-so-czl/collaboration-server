# TeamUp Collaboration Server

TeamUp 的协同编辑服务。它基于 Hocuspocus 和 Y.js 提供 WebSocket CRDT 同步，并把协同状态、Tiptap JSON 快照和便于 AI 消费的纯文本快照持久化到 MongoDB。

## 职责

- 为前端协同编辑器提供 Hocuspocus WebSocket 房间。
- 使用 Y.js CRDT 合并多人对同一文档的实时修改。
- 持久化 `ydoc_update` 二进制状态，以便下次进入文档时恢复完整协同状态。
- 基于与前端一致的 Tiptap 扩展导出 `content_json`，保留表格、链接、高亮、颜色、字号等富文本结构。
- 提取 `plain_text` 自然文本快照，让后端 AI 能够读取协作文档内容。
- 文档成功落盘后调用后端内部接口，由后端防抖触发协作文档摘要与协作记忆更新。

## 技术栈

- Node.js ESM
- `@hocuspocus/server`、Y.js
- Tiptap Transformer 与扩展集合
- MongoDB Node.js Driver
- dotenv

## 前置条件

- Node.js 20+（Node.js 18+ 可运行原生 `fetch`，推荐 20+）
- 可访问的 MongoDB
- 已启动的 TeamUp 后端；使用摘要回调时默认地址为 `http://127.0.0.1:8080`

## 安装与启动

```powershell
npm install
npm run dev
```

服务默认监听：

- HTTP：`http://127.0.0.1:1234`
- WebSocket：`ws://127.0.0.1:1234`

生产或常驻启动命令：

```powershell
npm start
```

快速语法检查：

```powershell
npm run check
```

## 配置

复制模板文件：

```powershell
Copy-Item .env.example .env
```

完整的本地配置示例：

```dotenv
# WebSocket 监听端口
PORT=1234

# MongoDB 协同快照存储
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=teamup
MONGODB_COLLECTION=collaboration_documents

# 协同内容落盘后的后端内部回调
SUMMARY_CALLBACK_URL=http://127.0.0.1:8080/internal/collaboration-summary/content-changed
COLLABORATION_SUMMARY_INTERNAL_TOKEN=replace-with-the-same-token-as-backend
```

`COLLABORATION_SUMMARY_INTERNAL_TOKEN` 必须与后端的同名环境变量一致。生产环境不要使用代码中的本地默认令牌，并应将回调地址限制在可信内网。

## 数据模型

每个协作文档以 `docId` 为主键保存在 MongoDB 的 `collaboration_documents` 集合：

| 字段 | 说明 |
| --- | --- |
| `docId` | 文档 ID，与业务后端的协作文档 ID 一致 |
| `ydoc_update` | Y.js 当前完整二进制协同状态 |
| `content_json` | 从 Y.Doc 导出的 Tiptap JSON 快照 |
| `plain_text` | 从富文本提取的 AI 可读纯文本 |
| `createdAt` / `updatedAt` | 创建和最近落盘时间 |

前端以文档 ID 作为 Hocuspocus 房间名。服务加载房间时恢复 `ydoc_update`；在 2 秒防抖、最长 10 秒后持久化最新状态。

## 与后端的回调契约

当文档成功写入 MongoDB 后，服务会发送：

```http
POST /internal/collaboration-summary/content-changed
Content-Type: application/json
X-Collaboration-Internal-Token: <shared-token>

{"documentId":"<docId>"}
```

该通知失败不会阻断文档保存。后端收到通知后通过 Redis 对同一文档防抖，并异步更新摘要和协作记忆。

## 联调顺序

1. 启动 MongoDB。
2. 启动 TeamUp 后端，并确保内部回调令牌已配置。
3. 设置本服务 `.env` 中的 MongoDB 和回调配置。
4. 启动本服务：`npm run dev`。
5. 启动 TeamUp 前端，并配置 `VITE_HOCUSPOCUS_URL=ws://127.0.0.1:1234`。

## 排查提示

| 现象 | 排查方式 |
| --- | --- |
| 服务启动失败 | 检查 `MONGODB_URI`、MongoDB 是否运行，以及端口是否被占用。 |
| 打开文档后内容为空 | 核对前端传入的房间名是否为正确文档 ID，并检查 `collaboration_documents` 中的 `ydoc_update`。 |
| 富文本格式丢失 | 确认服务端 `snapshotExtensions` 与前端编辑器的 Tiptap 扩展保持同步。 |
| 后端没有生成摘要 | 检查 `SUMMARY_CALLBACK_URL` 可访问性和两端 `COLLABORATION_SUMMARY_INTERNAL_TOKEN` 是否一致。 |
