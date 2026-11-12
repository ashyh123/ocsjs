# 学习通单视频工作流

用 Pi Durable 驱动 OCS Agent 的单视频任务。OCS 通过浏览器内的 `window.OCSAgent` 播放视频并读取平台任务点。Pi Durable 将任务和检查点保存在 SQLite。恢复时先核对同一任务点的平台状态，再决定完成或续跑。

## 运行

需要 Node.js 22.19 或更新版本、已安装 OCS Agent 用户脚本的 Ego Lite，以及一个已登录并打开目标视频课节、已交给 Agent 控制的 Space。先按 [OCS Agent 安装说明](../../docs/agent.md) 构建并安装脚本。

从仓库根目录运行：

```sh
npx pnpm@10.30.3 install --frozen-lockfile
node packages/durable/cli.mjs inspect <space-id> <page>
node packages/durable/cli.mjs --db <sqlite-file> start <space-id> <page> <task-id>
```

`inspect` 返回当前课节的视频任务点。复制目标视频的 `id`。数据库绑定一个视频和浏览器 Profile。课节提供学习通账号关联标识时，恢复还会核对该标识的摘要。登录态保留在浏览器中。

通过 `status` 查询或在运行器退出后用同一个数据库继续：

```sh
node packages/durable/cli.mjs --db <sqlite-file> status
node packages/durable/cli.mjs --db <sqlite-file> resume
```

如果浏览器关闭，任务保留等待状态。重新打开原 Space 和课节并交给 Agent 后，运行器会核对平台进度。如果浏览器要求用户手动开始播放或重新登录，按提示处理并回到原任务页。

## 什么时候调用模型

正常播放、断网等待、重新登录和进度核对全程零模型调用。视频结束后等待平台确认。连续读取到无法解释的状态时，工作流记录一次异常诊断并保留待处理状态。诊断提供说明，完成状态以学习通登记为准。

异常诊断可使用 OpenAI 兼容模型服务。配置 `OCS_AGENT_MODEL_URL`（以 `/v1` 结尾）、`OCS_AGENT_MODEL`，以及服务需要时的 `OCS_AGENT_MODEL_KEY`。本地地址可用 HTTP，远程地址使用 HTTPS。

## 验证

```sh
npx pnpm@10.30.3 --filter @ocsjs/durable test
npm run test:agent
npm run build:agent
```

工作流测试使用真实 SQLite 和 Pi Durable，浏览器端用例注入 OCS 的状态结果。进程强制退出用例在平台确认后、本地尚未登记完成时中断，核对重启后没有重复播放或调用模型。异常用例经本地 HTTP 验证模型请求次数。
