# dsh-bilibili-retrieval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#零运行时依赖)

**给 DeepSeek Harness 加一个"能读进视频里面"的 B 站检索层。**

通用搜索引擎对中文视频教程、课程、UP 主资源链接的检索质量很差——你搜到的是一条视频的标题，
而你需要的是它到底讲了什么、配套资料在哪、画面里在演示什么。这个插件补的就是从
"找到候选"到"读懂这条视频"之间的那一段。

> A Bilibili retrieval plugin for DeepSeek Harness. It searches videos, reads the creator's
> pinned comment and full description, pulls subtitles, samples real frames, and reports
> accurate time ranges — so Chinese video tutorials become first-class retrieval sources
> instead of opaque links. Zero runtime dependencies; no `ffmpeg`, no Python, no `sharp`.

---

## 目录

- [九个工具](#九个工具)
- [快速开始](#快速开始)
- [实测样例](#实测样例)
- [上下文与磁盘开销](#上下文与磁盘开销)
- [设计要点](#设计要点)
- [凭据与隐私](#凭据与隐私)
- [配置](#配置)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 九个工具

| 工具 | 作用 | 需要登录 |
|---|---|---|
| `bili_search` | 关键词搜视频：标题 / UP / 播放 / 点赞 / 收藏 / 时长 / 日期 / 简介 / 标签，**带噪音过滤** | — |
| `bili_video` | 单视频元数据：**简介全文**（`desc_v2`，保留原作者换行）、分 P 目录、统计、标签；相关视频按需（`related`，默认 0） | — |
| `bili_comments` | **UP 主置顶评论** + 热评，附带 `has_pinned` 与 `linkComment`（自动挑出含链接的评论） | — |
| `bili_frames` | **预览帧雪碧图**（默认 10×10 网格），真"看"画面，不需要 `ffmpeg` | — |
| `bili_cache` | 查看 / 清空预览图的磁盘占用（含旧版本遗留目录） | — |
| `bili_probe` | 诊断：双通道状态 + 一次真实搜索连通性 | — |
| `bili_transcript` | **字幕全文**（平台 / AI 字幕），**分片读取** + `[mm:ss]` 时间锚点 | ✅ |
| `bili_summary` | B 站自带 AI 摘要 + 大纲 | ✅（另有权限门槛，见[已知限制](#已知限制)） |
| `bili_login` | 扫码登录：`start` 出码并等待 / `status` 查有效性 / `logout` 清除 | — |

## 快速开始

### 从本地目录安装（开发用）

```powershell
dsh plugin --profile desktop add "link:C:/path/to/dsh-bilibili-retrieval"
```

装完**重启一次客户端**——bundle 层要重启才会组装。

> ⚠️ 用 `dshd plugin add` 会失败：那个包装脚本会把参数按字符拆开（实测传成
> `add l i n k ":" ...`）。必须用官方 CLI `dsh plugin --profile desktop add`。

### 验证安装

```
bili_probe
```

期望输出里 `search ok="true"`。如果 `authenticated` 显示 `not logged in`，说明登录通道没启用
——那只影响字幕和 AI 摘要，搜索 / 元数据 / 评论 / 抽帧照常可用。

### 启用字幕（可选）

```
bili_login action=start
```

会渲染一张二维码（同时存成 PNG），用手机 B 站扫码并在手机上确认。二维码 **3 分钟过期**，
过期后重新调用即可。

## 实测样例

`bili_comments` 拿到 UP 主置顶——通用搜索给不了的东西：

> 视频配套课件+源码+安装包等资料，三联后：www.bilibili.com/read/cv52421784

`bili_transcript` 拿到 902 条字幕 cue 合并成的正文，带时间锚点：

```
<cues>902</cues>
<range>0-4000 of 9473 chars (0:00-3:10 of 20:40); call again with startChar=4000 for the next slice</range>
<transcript>
[00:00] 好大家好啊那非常高兴啊大家来参加我们2021年这个理论卷的这个课程呃刑法呢…
[00:22] 都有一种望洋兴叹的畏惧感因为刑法的知识实在是太多了…
</transcript>
```

`bili_frames` 拿到 10×10 网格、100 帧的雪碧图，落在工作区的 `bili-frames/` 下，可直接预览。

## 上下文与磁盘开销

这两个都是**被明确要求控制的**，所以给了硬上限，不靠调用方自觉。

### 上下文

固定开销（每次请求都在上下文里的 `name` + `description` + `parameters`）≈ **1300 tokens**。
注意 `output.schema` **不进上下文**——框架只把这三个字段投影给模型。

单次调用典型开销：

| 调用 | 输出 |
|---|---|
| `bili_search limit=10` | ≈ 380 tokens（已过滤噪音） |
| `bili_video`（默认，无相关视频） | ≈ 254 tokens |
| `bili_transcript`（默认 4000 字） | ≈ 1300 tokens，带 `[mm:ss]` 锚点 |
| `bili_frames` | ≈ 100 tokens |

**字幕必须分片。** 早期版本默认上限 80000 字，一条两小时的课程就是 25000 tokens，一次调用
就能把上下文吃掉大半。现在默认 4000 字，返回 `hasMore` / `startChar` / `endChar` 和
`startSeconds` / `endSeconds`，读完整部只需按 `startChar` 续读，每次只付当片的价格。

**相关视频默认不返回。** `bili_video` 原来固定带 20 条相关推荐，是约 500 tokens 的无条件税
——哪怕你只想看简介。现在 `related` 默认 0。

### 搜索噪音过滤

**B 站的召回很宽**：搜「k8s 入门」会把「火炬之光…k8小时500火」当成命中（匹配了 `k8` 片段），
搜「react hooks」会返回一首叫《Sky Hooks》的歌。插件做三级处理：

1. **拉丁词按词边界匹配**，不看子串。`hooks` 不会命中 `skyhooks`，`k8s` 不会命中 `k8小时`。
2. **纯拉丁查询要求全部 token 命中**（`react hooks` 必须两个都有）；含中文的查询只要求命中
   一个，因为别名太常见（`k8s` vs `Kubernetes`）。
3. 当有 ≥3 条结果命中全部 token 时，只保留这些，把部分命中的剔除。

**只过滤，不重排。** B 站自身顺序已经含互动与新鲜度，按匹配分重排会把 61 分钟的优质教程压到
7 小时的课后面，仅因为标题写的是 `Kubernetes` 而非 `k8s`。

实测：`react hooks` 20 条滤掉 7 条；`Python 异步` 20 条滤掉 15 条，剩 5 条全相关。
若一条都没命中，会退回 B 站原始排序并标注 `unfiltered`（防止 `DSH` → `DeepSeek Harness`
这类别名查询被清空）。

### 磁盘

预览图写在工作区的 `bili-frames/`，**每次写入都会自动清理**：

- 上限 **12 张 / 24 MB**，超出就按修改时间删最旧的
- 刚写的那张永远保留，所以单张超大也一定拿得到路径
- 只写**一份**（早期版本同时写工作区和 `$DSH_HOME`，白占一倍空间）
- 只删 `.jpg`，不动目录里的其他文件
- `bili_cache action=report` 查看占用，`action=clear` 清空

两个上限都可以在 `cordis.patch.yml` 改 `framesMaxFiles` / `framesMaxBytes`。

## 设计要点

### 零运行时依赖

只用 Node 内置模块。不引入 `sharp`，不需要 `ffmpeg`，不用 Python。

连二维码编码器都是手写的（`lib/qr.js`）：插件用 `link:` 安装时，Node 从插件真实目录向上
解析依赖，而那里没有 `node_modules`，任何 npm 包都不可达。QR 实现（Model 2 / byte 模式 /
ECC-M / 版本 1-10）已对照 `qrcode` 包**逐模块**验证：强制同一掩码时矩阵完全一致。

### 不 import `@deepseek-ai/*`

插件通过 `ctx.tools.register()` 注册，`parameters` 与 `output.schema` 都用**标准 JSON Schema**。

原因：从任意目录安装的插件**无法解析** `@deepseek-ai/dsh-tools`——Node ESM 从插件文件向上
查找，而可达的那份往往是另一个大版本线。而 `register()` 只要求 `name` 和
`output { schema, render }`，根本不校验 `parameters`，所以这个 import 不必要；省掉它正好
避开社区插件"静默不激活"的失败模式。

### 双身份通道

```
匿名通道（宽配额：2s/请求，桶深 5）
  搜索 · 元数据 · 评论 · 抽帧

登录通道（严配额：3s/请求，桶深 2，单会话硬上限 20 次）
  字幕 · AI 摘要 · UP 投稿
```

风控分两层：IP 级被限只是变慢，等一会儿就恢复；**账号级被标记会跟着真人走**。
高频消耗留给匿名身份，账号只承担低频高价值调用。

### 通道选择的实测依据

同 IP 连续请求：

| 端点 | 第几次开始失败 | 失败表现 |
|---|---|---|
| `search/all/v2`（不签名） | 连续 20+ 次**全通** | — |
| `wbi/search/type`（签名） | 第 7 次 | `code:0` 但 `data` 只剩 `v_voucher` |
| `search/type`（不签名） | 第 2 次 | **HTTP 412** 风控页 |

主通道因此是 `all/v2`。

### 扫码登录的三个坑（都实测踩过）

1. **端点域名**：`api.bilibili.com/.../qrcode/generate` 返回 **404**，必须用
   `passport.bilibili.com`。
2. **cookie 在响应头里，不在 URL 里**：登录成功后 `data.url` 指向
   `passport.biligame.com/x/passport-login/web/crossDomain`，查询串只有
   `ticket/gourl/first_domain`。五个 cookie（`SESSDATA` / `bili_jct` / `DedeUserID` /
   `DedeUserID__ckMd5` / `sid`）**全部在 `Set-Cookie` 里**。只读 URL 会丢掉一次成功登录。
3. **二维码 3 分钟过期**：`86038`。`bili_login start` 默认只等 45 秒，过期就返回 `expired`。

### 字幕的权限真相

- 匿名：`need_login_subtitle: true`，轨列表为空。
- `view.subtitle.list` 可能带完整轨元数据（语言、`ai_type`、`is_lock`、作者），但
  `subtitle_url` **全部是空字符串**。登录**解锁 URL**，不**产生轨**。没轨的视频登录也没用。
- `need_login_subtitle` 匿名可读，是免费的预判：先判断"登录有没有用"，再决定花不花一次
  登录态请求。
- 字幕 JSON 在 CDN 上，匿名 fetch 是 403；但 `subtitle_url` 本身是预签名 URL，下载时
  **不带 cookie**。

### 结构化错误

B 站把问题表达成两种形态：HTTP 200 但 `code` 非零，或非 200 的 HTML 拦截页。两者都归一成
`BiliError`，带稳定码，避免把 HTML 漏进模型上下文。错误码会**前缀进 message**，因为工具
注册表把异常渲染成 `Error: <message>`，只放在属性里的 code 到不了模型。

| code | 含义 |
|---|---|
| `BILIBILI_LOGIN_REQUIRED` | 需要登录（字幕、AI 摘要） |
| `BILIBILI_RISK_CONTROL` | 风控拦截，冷却后重试 |
| `BILIBILI_FORBIDDEN` | 拒绝访问 |
| `BILIBILI_SUMMARY_FORBIDDEN` | AI 摘要的权限门槛高于普通登录，建议改用字幕 |
| `BILIBILI_NOT_FOUND` | 视频不存在或已删除 |
| `BILIBILI_SUBTITLES_UNAVAILABLE` | 没有可用字幕轨 |
| `BILIBILI_SPRITE_UNAVAILABLE` | 没有预览雪碧图 |
| `BILIBILI_BAD_RESPONSE` | 非 JSON / 非信封响应 |
| `BILIBILI_AUTH_BUDGET_EXHAUSTED` | 登录通道单会话配额用尽 |
| `BILIBILI_BAD_ARGUMENT` | 参数无法解析 |

## 凭据与隐私

**插件本身不含任何凭据、账号信息或本地路径。** 仓库里没有 `.env`、没有 cookie、没有用户 id。

登录凭据存在 `$DSH_HOME/bili/credential.json`（权限 `0600`），**不写 `.env`**——`.env` 的
每一行都会被注入到 harness 启动的每个子进程环境，等于把完整登录凭证散播出去。

凭据**只在** `api.bilibili.com` / `passport.bilibili.com` / `api.live.bilibili.com` 三个
origin 上发送，跨站请求绝不携带。这条有回归测试守着。

`bili_login status` 用 `nav` 做最便宜的过期检查（匿名 `-101` / 有效 `0` + `mid`）。
**不做自动续期**：`cookie/refresh` 需要 `refresh_token` + `csrf` + RSA-OAEP 的
`correspondPath`，而 SESSDATA 通常能撑数月，过期重扫更划算。

插件对 B 站账号是**只读**的：不点赞、不评论、不关注、不投币。

## 配置

默认值见 `cordis.patch.yml`。要覆盖，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里用
同一个 id（`bilibili-retrieval`）写一层 patch 即可，后写入的层按行覆盖。

```yaml
- insert:
    - id: bilibili-retrieval
      name: 'dsh-bilibili-retrieval'
      config:
        anonMinIntervalMs: 2000      # 匿名通道：每 N ms 一个请求
        anonBurst: 5                 # 匿名通道桶深
        authMinIntervalMs: 3000      # 登录通道：故意更严
        authBurst: 2
        authMaxPerSession: 20        # 登录通道单会话硬上限
        cacheTtlMetaMs: 86400000
        cacheTtlCommentsMs: 3600000
        cacheTtlSpriteMs: 604800000
        requestTimeoutMs: 20000
        credentialPath: ''           # 留空 = $DSH_HOME/bili/credential.json
        framesMaxFiles: 12           # 预览图保留张数
        framesMaxBytes: 25165824     # 预览图总字节上限（24 MB）
```

## 开发

```powershell
npm run verify    # 语法检查 + 42 个离线测试
```

测试全部离线，不需要网络、不需要登录。

覆盖：视频 id 解析、WBI `mixinKey` 与签名、错误码映射、HTML 拦截页归一化、缓存命中、
并发单飞、登录通道配额、凭据不跨站、**Set-Cookie 凭据提取**、QR 版本选择与结构、格式信息
往返、PNG 头合法性、**错误码必须出现在 message 里**、**预览图限额与清理**、**缓存报告扫工作区
而非 `process.cwd()`**、**每个工具的输出必须符合自己声明的 schema**、**搜索噪音过滤**、文案清洗。

### 真实 bug 的回归用例

这些用例不是凑数——每一条都对应一个真实踩过的坑：

| 用例 | 曾经的问题 |
|---|---|
| `anonymousCookie` 递归 | 生产表现为 78 秒卡顿 |
| `mixinKey` 截断 | 少截断到 32 字符，签名永远不对 |
| 凭据提取 | 只读 URL，丢掉一次真实登录（cookie 在 `Set-Cookie` 里） |
| `BiliError` 带 code | 模型只看到一句没有出路的「访问权限不足」 |
| 字幕分页字段 | 只加在返回值里、没加进 schema，被 `additionalProperties: false` 当场拒绝 |
| `pinned` 可空 | 用了 `type: ["object","null"]`，而注册表只接受单个字符串 type |
| 缓存报告 | 扫 `process.cwd()` 而非会话工作区，明明有 472 KB 的图却报「没有占用磁盘」 |
| 搜索噪音 | 搜「k8s 入门」返回「火炬之光 k8小时500火」，搜「react hooks」返回歌曲《Sky Hooks》 |
| `top_replies` 去重 | 把置顶评论原样重复一遍，白花读者注意力 |

`test/contract.test.js` 是一道结构性防线：用代表性值逐个跑每个工具的输出 schema，并检查
schema 只用了注册表支持的子集。任何工具加了字段却忘了改 schema，`npm run verify` 会先炸，
而不是等到线上调用时报 `invalid output`。

### 目录结构

```
index.js              工具注册、输出 schema、渲染器、system prompt section
lib/protocol.js       BiliClient：双通道限流、WBI 签名、缓存、单飞、错误归一化
lib/tools.js          搜索 / 元数据 / 评论 + 搜索噪音过滤
lib/subtitle.js       字幕三级降级 + 分片 + 时间锚点；AI 摘要
lib/frames.js         雪碧图抓取、落盘、限额清理、缓存报告
lib/login.js          扫码登录、凭据存取、有效性校验
lib/qr.js             手写 QR 编码器（Model 2 / byte / ECC-M / v1-10）+ PNG 输出
test/                 42 个离线测试
```

## 已知限制

- **AI 摘要需要高于普通登录的权限**：实测一个等级 2、未实名的账号，`view/conclusion/get`
  的签名版、不签名版、带 Origin 版**全部返回 `-403`**。字幕在同一个账号下正常。失败时抛
  `BILIBILI_SUMMARY_FORBIDDEN`，消息里直接建议改用 `bili_transcript`。
- **字幕只有本来就带轨的视频才有**。没轨的视频登录也不会有。
- **`bili_frames` 的 `timestamps` 不可靠**：B 站对同一视频可能返回 48 条也可能返回 0 条，
  不能当分帧时间轴用。网格几何以 `img_x_len × img_y_len` 为准。
- **字幕 ASR 会拼错技术名词**：`Kubernetes` 可能被转成 `COGNITY` / `cube nice`，
  `Portainer` 变成 `partner`。需要靠上下文校准。
- **弹幕密度分析**未做成独立工具。
- **没有设置页 UI**，所有参数走 `cordis.patch.yml`。
- **评论只读第一页**（约 20 条顶级评论）。更深的资源链接不会出现在 `bili_comments` 里，
  返回值用 `pageComplete: false` 和 `<scope>` 标注了这一点。

## 许可

[MIT](LICENSE)

---

本项目与哔哩哔哩（bilibili）官方无关，仅通过公开 Web 接口读取公开内容。
请自行遵守目标站点的服务条款，控制请求频率。
