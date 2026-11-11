# OCS Agent：超星视频预览版

本 fork 提供独立的 `ocs.agent.user.js`。它在超星页面显示操作面板，并向 Egolite 等浏览器 agent 暴露 JSON 接口。这个入口不会启动原版 OCS 的自动项目生命周期，章节切换由 agent 决定。

## 构建与安装

```sh
npx pnpm@10.30.3 install --frozen-lockfile
npm run build:agent
```

产物是 `dist/ocs.agent.user.js`，自包含且不需要远程 `@require`。在 Egolite 安装 Tampermonkey 或 ScriptCat 后，用脚本管理器导入文件，或新建脚本、粘贴全文并保存。根据管理器提示开启 Chromium 的用户脚本权限。

同一浏览器先停用原版 OCS 脚本，避免两份脚本同时播放和跳转。在已登录的超星课程页刷新后，应出现“OCS Agent · 超星视频”面板。可以先通过面板识别任务、开始、暂停、继续和停止。当前匹配 `chaoxing.com`、`xuexi365.com`；学校独立域名需要单独验证后再扩展。

## Agent 接口

先读取本机安装版本的 `ego-browser skill`，按该版本的 API 取得已授权页面，再通过页面执行接口调用 `window.OCSAgent`。例如持有 `page` 时：

```js
const state = await page.evaluate(() => window.OCSAgent.inspect());
const task = state.observation.tasks.find((t) => t.availability === 'executable' && t.platformStatus !== 'confirmed');
if (task) await page.evaluate((id) => window.OCSAgent.start(id), task.id);
```

| 方法                                 | 作用                                             |
| ------------------------------------ | ------------------------------------------------ |
| `describe()`                         | 获取版本、执行范围和方法列表                     |
| `inspect()` / `getStatus()`          | 新鲜页面观察、逐帧运行状态、不可达帧及课程记忆   |
| `start(taskId)`                      | 启动身份明确的当前视频，立即返回状态             |
| `pause()` / `resume()` / `stop()`    | 控制执行器                                       |
| `openChapter(chapterId)`             | 点击当前目录里已识别的章节；导航后重新 inspect   |
| `openTask(taskId)`                   | 定位当前已发现的视频，未知目标报错               |
| `readEvents({[contextId]: lastSeq})` | 按上下文增量读取事件；新文档使用新游标           |
| `getMemory()`                        | 读取按 courseId / clazzId 隔离的持久化观察和断点 |
| `nextTask()`                         | 从新鲜观察中选择下一个可执行且未确认的视频       |

长视频不要放在单次 evaluate 中等待。启动后分次调用 `getStatus()`，区分脚本响应时间、媒体进展、验证阻塞和平台任务状态。命令在协调器内串行执行；同一任务重复 start 不会启动第二份执行器。停止或导航遇到不可达旧帧时会报错，应重新 inspect 并对账。

## 课程记忆与切换

记忆使用脚本管理器存储，同一安装刷新后保留。记录稳定任务身份、章节列表、已观察任务、切换策略和断点，不存 Cookie、令牌、DOM 节点或 Egolite 临时元素编号。

首次执行先扫描目录并进入章节，调用 inspect 建立任务地图。当前适配器只确认已加载媒体的任务身份；未进入的章节由 agent 结合目录和 Egolite 快照逐一探索，使用 `openChapter` 后重新发现任务。`nextTask` 不会把历史任务直接当成当前可执行目标。

播放结束是 `awaiting_confirmation`。只有重新观察到同一 jobId 的平台 `isPassed === true` 才会标记 `completed`。目录无法证明完整时保持 `unknown/partial`，即使所有已观察视频都确认，也不会宣称整门课全部完成。测验、阅读和文档不在本预览版执行范围内。

## 验证范围

```sh
npm run test:agent
npm run build:agent
npm run test:agent:browser
```

浏览器验证使用本机 Chromium（默认 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定）、本地媒体与模拟超星页面，覆盖播放控制、平台完成确认、切章、跨来源 iframe 和刷新后记忆恢复。测试模拟脚本管理器 API。

这些测试不证明真实账号、真实课程、Egolite 或具体脚本管理器版本已经兼容。首次实机联调需要检查 userscript 沙盒桥接、实际 DOM 和学校域名。登录或人脸验证返回等待状态，由用户完成后继续。
