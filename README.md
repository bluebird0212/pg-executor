# Bluebird PG

把浏览器里的 **Google AI Studio** 变成一个标准的 **Gemini API**，给 SillyTavern / NextChat / Cherry Studio 等客户端使用。

- 不需要导出 Cookie，不需要签名服务，不需要无头浏览器。
- 请求由 AI Studio 页面自己发出，脚本只负责转发。
- 自带「缓存回放」：上游断线 / 额度用完 / 想重复上一次回复时，可以把最近一次成功响应再回放一次。
- 面板自带 **最近请求记录、完成通知、Token 用量统计**，还能一键复制 API 主机和 API Key。
- 电脑和 Android 手机都能用：服务跑在本机，油猴脚本跑在 AI Studio 页面。

> 仅供个人学习研究，请遵守 Google 的服务条款，不要用于商业或滥用。
>
> **手机一键安装页**：<https://bluebird0212.github.io/pg-executor/install.html>

---

## 它是怎么工作的

```
客户端 (SillyTavern 等)
        │  Gemini API (http://127.0.0.1:8090/v1beta)
        ▼
   Bluebird PG 本地服务
        │  长轮询下发任务（不需要 WebSocket，手机也能用）
        ▼
   AI Studio 页面里的油猴脚本
        │  在页面上下文里生成 proof、带上页面请求头
        ▼
   Google AI Studio 上游
```

本地服务负责把 Gemini 请求编码成 AI Studio 的 wire 格式，并把浏览器抓回来的原始响应解析成标准 Gemini JSON / SSE。

### 为什么还要启动一个小服务？

Playground Executor 之所以「装完脚本就能用」，是因为它们连接的是作者在公网架设的中转服务器。

本项目默认**不把请求发给第三方**：油猴脚本连接的是你自己的电脑。浏览器脚本本身无法监听端口，所以需要一个很小的本地服务来转发。

- Windows：下载 `bluebird-pg.exe`，双击即可，**不需要安装 Python**。
- 手机 / 其他系统：用 `start.sh` 或手动运行 `server.py`。
- 面板会自动扫描 `8090 / 8080 / 8091` 等常见端口，找到服务后自动连接，不需要手填地址。

### 面板能做什么

- **自动发现服务**：找不到时显示启动引导和下载按钮。
- **一键局域网**：点「🏠 局域网」自动读取服务端网卡地址并填好，省去手动查 IP。
- **客户端连接**：显示 API 主机和 API Key，可分别复制或一键复制全部（协议选 Google Gemini）。
- **最近请求**：最近 20 条记录，显示时间、模型、耗时、成功/失败、Token。
- **Token 统计**：累计输入 / 输出 / 总 Token，以及上一次请求的用量。
- **完成通知**：请求成功或失败时，页面顶部弹出小提示。
- **多缓存回放**：保留最近 10 份响应，可以自己挑一份回放。
- **PG 次数查询**：选普通 / Pro / Ultra 套餐后，按内置额度表列出今天各模型用了多少次、还剩多少次。
- **报错查询**：内置常见状态码（200/400/401/403/404/429/499/502/503/504/524）的原因和解决办法，支持关键词搜索。
- **快速换号**：面板「🔄 换号」直接切换 Google 多账号（`/u/N/`），跳到该账号的临时会话页重新引导。
- **防重复请求**：同一份请求还在处理时，服务端会拦住重复发送，避免一次操作消耗多份额度。
- **防路由护盾**：服务端自动做首尾动态混淆，降低被谷歌识别成固定预设的概率。
- **防截断**：流式响应没有正常结束时会自动续写一次。
- **自动引导**：连接成功后自动发送一条 `hi` 完成签名环境引导。
- **日志 / 后台保活 / 昼夜主题**。
- **刷新即重置**：成功/失败计数和本次请求记录每次刷新页面都从 0 开始；Token 累计和缓存会保留。

---

## 一、电脑上使用（Windows）

### 方案 A：一键版（推荐，无需 Python）

1. 打开 [Releases](https://github.com/bluebird0212/pg-executor/releases/latest)，下载 `bluebird-pg.exe`。
2. 双击运行。如果 Windows SmartScreen 拦截，点「更多信息」→「仍要运行」。
3. 看到黑色窗口显示「Bluebird PG 正在启动」即可，**这个窗口不要关**。
4. 浏览器装好油猴脚本并刷新 AI Studio，面板会自动找到 `http://127.0.0.1:8090`。

### 方案 B：Python 源码版

#### 1. 安装 Python

安装 **Python 3.11 或更高版本**：<https://www.python.org/downloads/>

安装时务必勾选 **Add Python to PATH**。

#### 2. 下载并启动服务

下载本仓库（Code → Download ZIP）并解压，双击 **`start.bat`**。

第一次运行会自动创建虚拟环境并安装依赖，需要联网，可能比较慢。启动成功后：

- 控制台：<http://127.0.0.1:8090>
- 客户端 Base URL：`http://127.0.0.1:8090/v1beta`

> 国内网络如果依赖安装失败，可以在 `pg-bridge` 目录手动执行：
>
> ```bat
> .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```

#### 3. 安装油猴脚本

1. 浏览器安装 **Tampermonkey** 扩展。
2. 打开安装链接：

   <https://raw.githubusercontent.com/bluebird0212/pg-executor/main/pg_executor.user.js>

   Tampermonkey 会弹出安装页，点「安装」。

   > jsDelivr 在一些网络下会被墙，所以默认用 raw 链接；如果 raw 打不开，可以试 jsDelivr：<https://cdn.jsdelivr.net/gh/bluebird0212/pg-executor@main/pg_executor.user.js>（内容一样）。
   > 之前装过旧版 **PG Bridge Executor** 的，请在 Tampermonkey 里删除旧脚本，只保留 **Bluebird PG**。

3. 登录 <https://aistudio.google.com>，建议打开：

   <https://aistudio.google.com/prompts/new_chat?temporary=true>

4. 页面右下角会出现 **Bluebird PG** 面板。服务没启动时，面板会显示「还差一步：启动本地服务」的引导；启动后点「🔄 我已启动」即可。
   面板会自动扫描 `8090 / 8080 / 8091` 等端口，找到服务后自动连接。
   面板支持 **自动 / 日间 / 夜间** 三种主题，点标题栏右侧的 ☀️/🌙 按钮切换。

#### 4. 客户端设置

以 SillyTavern 为例：

| 项目 | 填写 |
| --- | --- |
| API 类型 | Chat Completion |
| 来源 | Google AI Studio |
| 反向代理地址 | `http://127.0.0.1:8090/v1beta` |
| 代理密码 / API Key | 随意填任意非空字符，例如 `123` |

NextChat / Cherry Studio 等：

- 协议必须选 **Google Gemini**，不要选 OpenAI。
- API Base URL：`http://127.0.0.1:8090/v1beta`
- API Key：任意非空字符。

#### 5. 第一次请求

第一次请求时脚本会自动打开临时会话页并触发一次页面发送来捕获签名环境：

- 如果客户端提示「正在打开临时会话页」，等页面加载完再发一次即可。
- AI Studio 页面可能出现一次报错提示，这是脚本拦截引导请求造成的，属正常现象。
- 面板显示「签名已就绪」后就能正常对话。

---

## 二、手机上使用（Android）

### 方案 A：手机只当执行器，服务跑在电脑上（推荐）

1. 电脑按上面的步骤启动服务。
2. 让服务监听局域网（二选一）：

   ```bat
   set PG_HOST=0.0.0.0
   bluebird-pg.exe
   ```

   或者源码版：

   ```bat
   set PG_HOST=0.0.0.0
   .venv\Scripts\python.exe server.py
   ```

   Windows 防火墙弹窗时选择「允许」。
3. 手机安装支持油猴脚本的浏览器（如 **Firefox for Android**、Kiwi、Cromite），安装 Tampermonkey 和本脚本。
4. 手机登录 AI Studio，打开临时会话页，在 Bluebird PG 面板把服务地址改成：

   ```
   http://电脑局域网IP:8090
   ```

   例如 `http://192.168.1.10:8090`（可在电脑 `ipconfig` 里查看 IPv4 地址）。
5. 连接成功后，面板的「客户端连接」会自动显示手机可用的 API 主机，点「📋 主机」或「📦 全部」复制到手机客户端即可。

### 方案 B：服务和浏览器都在手机上（Termux）

1. 安装 **Termux**，执行：

   ```bash
   pkg update
   pkg install python git
   git clone https://github.com/bluebird0212/pg-executor.git
   cd pg-executor
   python -m venv .venv
   .venv/bin/python -m pip install -r requirements.txt
   .venv/bin/python server.py
   ```

   也可以用仓库里的 `start.sh`。

2. 手机浏览器（支持 Tampermonkey 的 Firefox / Kiwi / Cromite）安装脚本。
3. AI Studio 页面里的服务地址保持 `http://127.0.0.1:8090`。
4. 客户端 Base URL：`http://127.0.0.1:8090/v1beta`。

> Android Chrome 本身不支持扩展，所以不能直接用 Chrome 装油猴脚本。

### 方案 C：用一台旧手机当服务器（推荐给有备用机的）

旧手机只跑服务，不需要登录 Google，也不用装油猴；主力手机/电脑继续当 AI Studio 执行器。

1. 旧手机安装 **Termux**（建议从 F-Droid 装最新版）。
2. 在 Termux 里执行一条命令：

   ```bash
   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/bluebird0212/pg-executor/main/termux.sh | bash
   ```

   也可以先用浏览器打开 <https://github.com/bluebird0212/pg-executor/blob/main/termux.sh>，复制内容保存为 `termux.sh` 后执行 `bash termux.sh`。

3. 首次运行会自动下载 Ubuntu Base（清华 TUNA 镜像）和 Python 依赖，需要几百 MB 空间，耐心等它跑完。
   > 脚本不使用 Docker Hub，国内网络也能装完；apt 和 PyPI 都走清华镜像。
4. 看到 `Bluebird PG 已启动` 后，记下脚本打印的手机局域网地址（例如 `http://192.168.1.6:8090`）。
5. 主力设备的 Bluebird PG 面板地址填：

   ```
   http://旧手机局域网IP:8090
   ```

6. 日常使用：

   ```bash
   bash ~/start-pg.sh            # 启动；已经在运行会直接提示
   bash ~/start-pg.sh restart    # 强制重启
   bash ~/stop-pg.sh             # 停止
   tail -n 50 ~/server.log       # 查看日志
   ```

7. 手机重启后需要手动执行一次 `bash ~/start-pg.sh`；旧手机建议一直插电，并在系统设置里允许 Termux 后台运行、关闭它的电池优化。
8. 只在自己家的局域网使用，不要把 8090 端口映射到公网。

> 这条路线不需要 exe，也不需要 Windows；代价是首次安装较慢，旧手机要保持 Termux 不被系统杀掉。

---

## 三、缓存回放（支持多份）

脚本会把每次成功的原始响应保存下来，最多保留 10 份：

1. 先在面板点 **「📦 管理」**（或直接点「🎀 缓存回放」）打开缓存列表。
2. 每一行显示时间、模型、大小，点 **「回放」** 选中要用的那一份。
3. 下一次请求不再访问上游，直接把这份缓存按当前请求的流式 / 非流式模式返回。
4. 回放完成后自动取消选中。

只有一份缓存时，点「🎀 缓存回放」会直接选中它；有多份时会打开列表让你挑。点「🧹 清空缓存」会删除全部缓存。

适合场景：

- 上游临时抽风、429、断网，但你想先让客户端拿到一份可用的回复。
- 调试客户端时不想反复消耗额度。
- 想重复查看某一次回复。

注意：回放内容与当前问题无关，只是原样返回选中的那次结果。

---

## 四、护盾、次数与报错查询

### 防路由护盾与防截断

这两个功能在**服务端**实现，对所有客户端（SillyTavern / NextChat / Cherry Studio）统一生效，不用改酒馆预设。

- **防路由护盾**：在 systemInstruction 首部、对话流首部/尾部插入动态注释，并对常见固定套话做同义微替换、行尾空格抖动。不使用零宽字符，避免触发流式截断。默认「深度」模式。
- **防截断**：流式响应如果没收到正常结束标记，会自动把已生成内容作为上文，再发一次「继续写」请求补全，然后统一收尾。
- 面板底部的 **「🛡 防路由」** 按钮可以随时开关护盾，状态保存在服务进程里，重启服务后恢复默认（开启）。
- 想永久关闭可以在启动前设置环境变量 `PG_SHIELD=0`，或 `PG_ANTI_TRUNCATE=0` 关闭防截断。

> 护盾会让提示词变长（注入的注释会占 Token），如果更在意省额度可以在面板里关掉。

### PG 次数查询

点面板底部 **「📊 次数」**：

1. 先选自己的套餐：普通账号 / Pro 账号 / Ultra 账号。
2. 面板按内置额度表列出各模型的「已用 / 上限」和「剩余次数」。
3. 次数 ≤ 5 会变黄，用完变红；鼠标悬停能看到 Token 用量。
4. 额度按北京时间每天 **16:00** 重置，面板会自动换日。
5. `gemini-flash-latest`、`gemini-pro-latest` 会自动归并到 `gemini-3.8-flash`、`gemini-3.1-pro-preview` 统计。

> 统计按「实际发往上游的请求」计数（失败也算，因为额度已经被消耗），按天保存；换浏览器或换设备后是独立计数。

### 报错查询

点面板底部 **「🔎 报错」**，输入状态码（如 `429`）或关键词（如 `区域`、`验证`）即可筛选。点最近请求里失败的那条，也会自动打开并带入状态码。

内置内容整理自社区状态码图，覆盖登录、额度、内容审核、流式超时、多个执行器冲突等常见情况。

---

## 五、常见问题

**Q：页面上完全看不到 Bluebird PG 面板？**

1. 在 Tampermonkey 里确认脚本已启用，版本是 **1.5.1**。
2. 新装的脚本不会注入已经打开的标签页，**必须刷新 AI Studio 页面**。
3. 确认当前地址是 `https://aistudio.google.com/...`，脚本只匹配这个域名。
4. 面板固定在右下角，标题栏会显示 `✓成功 ✗失败` 次数；连接失败时面板里会出现红色错误行。
5. 如果仍然看不到，按 `F12` 打开 Console，看有没有 `[Bluebird-PG] 脚本已加载`：
   - 没有这条日志：脚本没运行，检查 Tampermonkey 图标、是否无痕模式、是否被其他扩展禁用。
   - 有日志但没有面板：把 Console 里的红色报错截图发 Issue。
6. 1.5.1 会每 2.5 秒自动把面板重新挂回页面，AI Studio 切换会话导致 DOM 重建后也会自动恢复；同时已移除 `innerHTML`，兼容 AI Studio 的 Trusted Types 限制。

**Q：更新时出现 “This page is used as an intermediate step…” 页面怎么办？**

这是 Tampermonkey 的安装中转页，正常情况下会自动关闭并弹出安装/更新确认。如果一直停在这里：

1. 重新打开 <https://raw.githubusercontent.com/bluebird0212/pg-executor/main/pg_executor.user.js>，等 2~3 秒。
2. 还不行就打开 Tampermonkey 面板 →「实用工具」→「从 URL 安装」，粘贴上面的 raw 链接。
3. 或者 Tampermonkey →「添加新脚本」，把脚本内容整段粘贴进去，Ctrl+S 保存。
4. 更新后刷新 AI Studio，确认面板版本是 **1.5.1**。

**Q：一定要用 exe 吗？没有更简单的办法吗？**

不是必须用 exe，但**必须有一个能监听端口的小服务**，因为浏览器脚本自己不能提供 API 地址。

- `bluebird-pg.exe` 只是 Windows 上最省事的一键打包，不需要装 Python。
- 有 Python 的电脑可以用 `start.bat` / `server.py`。
- 手机可以全部跑在 Termux 里，也可以把服务放在 NAS、树莓派或 VPS 上。
- Catiecli / Playground Executor 能「只装脚本」，是因为作者在公网架了中转服务器；Bluebird PG 默认不上传你的请求，所以服务跑在你自己这边。

**Q：面板里的「API 主机 / API Key」怎么用？**

- 协议选 **Google Gemini**。
- API 主机点「📋 主机」复制，例如 `http://127.0.0.1:8090/v1beta`；手机连电脑时会是 `http://电脑IP:8090/v1beta`。
- API Key 点「🔑 Key」复制；服务默认不校验 Key，填面板里生成的即可。
- 懒得分开复制就点「📦 全部」，会一次复制协议、主机和 Key。

**Q：Token 统计为什么有时是 0？**

- 使用缓存回放时没有真实请求，所以不计 Token。
- 某些上游响应不带 usage 字段，这一条会记为 0。
- 统计只存在浏览器本地，不会上传。

**Q：面板显示「本地连接不可用 / 未找到本地服务」？**

1. 还没有启动本地服务：双击 `bluebird-pg.exe` 或 `start.bat`。
2. 服务窗口被关掉了：重新双击，窗口不要关。
3. 端口被占用：在命令行先 `set PG_PORT=8091`，再运行 `bluebird-pg.exe`；面板会自动扫描 8091。
4. Windows 防火墙弹窗：点「允许访问」。
5. 手机连电脑：电脑启动前先 `set PG_HOST=0.0.0.0`，手机面板地址改成 `http://电脑局域网IP:8090`。

**Q：控制台显示「执行器未连接」？**

- 确认 AI Studio 页面还开着，并且 Bluebird PG 面板显示「已连接」。
- 确认面板里的服务地址和 `start.bat` 启动的地址一致。
- 手机连电脑时，确认两台设备在同一 Wi-Fi、电脑防火墙放行 8090 端口。

**Q：面板显示「签名未就绪」是怎么回事？**

「签名」指 AI Studio 页面用来生成请求证明（proof）的三个运行时条件：页面模块里的 snapshot 函数、发请求用的 service 对象、以及页面请求头。三者任意一个没抓到，面板就会显示未就绪。

- 这只是**暂时状态**，不是报错。打开临时会话页后，脚本会自动发送一条 `hi` 触发页面请求，抓齐环境后就会变成「签名已就绪」。
- 1.5.1 起连接成功后会自动引导；也可以在面板点「✨ 手动引导」。
- 如果一直不就绪：确认面板底部的「✨ 自动引导·开」，然后点「拓展/手动引导」；仍不行就在页面里手动发一条消息。
- 客户端第一次请求也会自动补一次引导，所以看到未就绪时直接发请求通常也能通。

**Q：为什么某些模型名会报 404 / Requested entity was not found？**

说明当前 AI Studio 账号页面没有这个模型。实际可用的是 `gemini-flash-latest`、`gemini-pro-latest`、`gemini-3.5-flash-lite` 等，面板内置列表里以第一个（默认）为准。换一个能用的模型名即可。

**Q：只发了一次请求，为什么消耗了好几次额度？**

常见原因：

1. **客户端自动重试**：SillyTavern 等客户端在超时、499、空回复时会自动重试，每次重试都是一次真实的上游请求。
2. **防截断续写**：流式响应没有正常结束时，服务端会补一次「继续写」，这次也会消耗额度。
3. **多个执行器**：同时开了多个 AI Studio 标签页或多个 PG 脚本，会重复接任务。

1.5.3 起服务端会拦截「同一份请求还在处理中」的重复发送；但客户端在收到错误后的再次重试属于新请求，建议把酒馆的自动重试次数调低，并确保只开一个执行器标签页。

**Q：客户端报 429 / 403？**

- 这是 Google 账号侧的额度或风控，不是本地服务的问题。
- 换账号、等额度重置，或先用缓存回放顶一下。

**Q：手机锁屏后请求就断了？**

- 手机浏览器会冻结后台标签页。保持 AI Studio 页面在前台，或在面板打开「后台保活」。
- Android 省电策略也可能杀掉浏览器，必要时把浏览器加入白名单。

**Q：支持图片 / 思维链 / 工具调用吗？**

编码和解析复用了 [aistudio-api](https://github.com/DeconstructedCube/aistudio-api) 的 wire 编解码，文本、思维链、图片、函数调用都会按 Gemini 格式返回；实际可用性取决于 AI Studio 网页当前支持的模型和能力。

**Q：模型列表是固定的吗？**

内置了一份常用模型列表；如果执行器上报了额外模型，也会一起显示。模型名必须和 AI Studio 页面上的模型一致。

---

## 六、安全说明

- 默认只监听 `127.0.0.1`。只有你主动设置 `PG_HOST=0.0.0.0` 时才会暴露到局域网。
- **不要把 8090 端口映射到公网。** 服务本身没有强鉴权，等于把你的 AI Studio 账号能力开放出去。
- 如果需要简单防护，可以设置环境变量 `PG_TOKEN`，客户端请求时带 `x-api-key: 你的token`。
- 本项目不保存你的 Google 账号密码或 Cookie；请求头只存在于浏览器内存里。

---

## 七、目录结构

```
pg-bridge/
├─ server.py             # 本地 Gemini 兼容服务 + 执行器调度
├─ pg_executor.user.js   # 油猴脚本（AI Studio 页面执行器）
├─ start.bat             # Windows 一键启动
├─ start.sh              # Termux / Linux / macOS 启动
├─ requirements.txt
└─ README.md
```

---

## 八、致谢

- wire 编解码与响应解析依赖 [DeconstructedCube/aistudio-api](https://github.com/DeconstructedCube/aistudio-api)（MIT）。
- 执行器协议参考了 Catiecli Playground Executor 的公开实现，本仓库为独立重写版本。

如果 AI Studio 页面结构变化导致脚本失效，欢迎提 Issue 或自行调整 `pg_executor.user.js` 里的 hook 匹配逻辑。


