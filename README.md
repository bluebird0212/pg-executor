# Bluebird PG

把浏览器里的 **Google AI Studio** 变成一个标准的 **Gemini API**，给 SillyTavern / NextChat / Cherry Studio 等客户端使用。

- 不需要导出 Cookie，不需要签名服务，不需要无头浏览器。
- 请求由 AI Studio 页面自己发出，脚本只负责转发。
- 自带「缓存回放」：上游断线 / 额度用完 / 想重复上一次回复时，可以把最近一次成功响应再回放一次。
- 电脑和 Android 手机都能用：服务跑在本机，油猴脚本跑在 AI Studio 页面。

> 仅供个人学习研究，请遵守 Google 的服务条款，不要用于商业或滥用。

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

Catiecli / Playground Executor 之所以「装完脚本就能用」，是因为它们连接的是作者在公网架设的中转服务器。

本项目默认**不把请求发给第三方**：油猴脚本连接的是你自己的电脑。浏览器脚本本身无法监听端口，所以需要一个很小的本地服务来转发。

- Windows：下载 `bluebird-pg.exe`，双击即可，**不需要安装 Python**。
- 手机 / 其他系统：用 `start.sh` 或手动运行 `server.py`。
- 面板会自动扫描 `8090 / 8080 / 8091` 等常见端口，找到服务后自动连接，不需要手填地址。

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
2. 在电脑上让服务监听局域网：

   ```bat
   set PG_HOST=0.0.0.0
   .venv\Scripts\python.exe server.py
   ```

   Windows 防火墙弹窗时选择「允许」。
3. 手机安装支持油猴脚本的浏览器（如 **Firefox for Android**），安装 Tampermonkey 和本脚本。
4. 手机登录 AI Studio，打开临时会话页，在 Bluebird PG 面板把服务地址改成：

   ```
   http://电脑局域网IP:8090
   ```

   例如 `http://192.168.1.10:8090`（可在电脑 `ipconfig` 里查看 IPv4 地址）。
5. 手机客户端（或电脑客户端）的 Base URL 填：

   ```
   http://电脑局域网IP:8090/v1beta
   ```

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

---

## 三、缓存回放

面板上的 **「下次用缓存回放」** 是一次性开关：

1. 先成功执行一次请求（脚本会把最近的原始响应存下来，只保留最新一份，最大 8 MB）。
2. 点「下次用缓存回放」。
3. 下一次请求不再访问上游，直接把缓存内容按当前请求的流式 / 非流式模式返回。
4. 回放完成后开关自动关闭。

适合场景：

- 上游临时抽风、429、断网，但你想先让客户端拿到一份可用的回复。
- 调试客户端时不想反复消耗额度。
- 想重复查看上一次的回复。

注意：回放内容与当前问题无关，只是原样返回上一次结果。

---

## 四、常见问题

**Q：页面上完全看不到 Bluebird PG 面板？**

1. 在 Tampermonkey 里确认脚本已启用，版本是 **1.3.0**。
2. 新装的脚本不会注入已经打开的标签页，**必须刷新 AI Studio 页面**。
3. 确认当前地址是 `https://aistudio.google.com/...`，脚本只匹配这个域名。
4. 面板固定在右下角，标题栏会显示 `✓成功 ✗失败` 次数；连接失败时面板里会出现红色错误行。
5. 如果仍然看不到，按 `F12` 打开 Console，看有没有 `[Bluebird-PG] 脚本已加载`：
   - 没有这条日志：脚本没运行，检查 Tampermonkey 图标、是否无痕模式、是否被其他扩展禁用。
   - 有日志但没有面板：把 Console 里的红色报错截图发 Issue。
6. 1.3.0 会每 2.5 秒自动把面板重新挂回页面，AI Studio 切换会话导致 DOM 重建后也会自动恢复；同时已移除 `innerHTML`，兼容 AI Studio 的 Trusted Types 限制。

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

**Q：面板显示「签名未就绪」？**

- 打开 `https://aistudio.google.com/prompts/new_chat?temporary=true`。
- 点面板「手动引导」，或手动在页面发一条消息（随便发个 `hi`）。
- 如果页面改版导致自动引导失效，需要更新脚本。

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

## 五、安全说明

- 默认只监听 `127.0.0.1`。只有你主动设置 `PG_HOST=0.0.0.0` 时才会暴露到局域网。
- **不要把 8090 端口映射到公网。** 服务本身没有强鉴权，等于把你的 AI Studio 账号能力开放出去。
- 如果需要简单防护，可以设置环境变量 `PG_TOKEN`，客户端请求时带 `x-api-key: 你的token`。
- 本项目不保存你的 Google 账号密码或 Cookie；请求头只存在于浏览器内存里。

---

## 六、目录结构

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

## 七、致谢

- wire 编解码与响应解析依赖 [DeconstructedCube/aistudio-api](https://github.com/DeconstructedCube/aistudio-api)（MIT）。
- 执行器协议参考了 Catiecli Playground Executor 的公开实现，本仓库为独立重写版本。

如果 AI Studio 页面结构变化导致脚本失效，欢迎提 Issue 或自行调整 `pg_executor.user.js` 里的 hook 匹配逻辑。
