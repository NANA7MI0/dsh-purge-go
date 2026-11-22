# dsh-purge-go

把 **dsh-purge**（基于社区维护版）移植适配到 **dsh-go** 中，只保留核心功能——**提示词注入**和**引擎源码补丁**，其他功能在手机端没有落点，一并抛弃。

社区把这类插件统称「破甲」（下文沿用这个叫法，胶囊上的字也是这么写的）。它不改模型权重、不发网络请求、不动你的项目文件。

许可证 **AGPL-3.0**，按现状提供、不附带任何担保（[LICENSE](LICENSE) 里有完整条款）。**装不装、装完怎么用、什么时候撤，由你自己决定。**

装完输入框上方多一个「破甲状态」胶囊，点它直接打开状态界面；出问题时上方会自己冒一条红色状态条，点它也是进同一个界面。安装时会把 App 自带的「插件」胶囊一并藏起来——那是个插件列表入口，本仓库只有一个插件，点进去是同一个面板，留着只会让人以为装重了。想恢复就删掉 `~/.dsh/dsh-go/ui.json` 里 `hide` 数组的 `pluginCapsule` 一项。

<img src="docs/panel-status.jpg" width="360" alt="破甲状态面板：顶部一句总状态、补丁层 57/57、注入/正文/变体/模型/待办五行、四个按钮、下方明细表">

*点胶囊打开的就是这一屏（截图为正常工作状态）*

> **只适配 DeepSeek。** 换别的模型不会报错，但注入正文是按 DeepSeek 的格式写的，效果会打折扣，见 [只适配 DeepSeek](#只适配-deepseek)。
>
> 红队是**独立配套包**，与本仓库互不依赖、不装不影响这里的任何功能，见 [9. 来源](#9-来源)。

## 快速导航

不想读全文就按这张表跳：

| 我要做什么 | 去哪 |
|---|---|
| **App 更新后破甲没了** | [5. 出问题怎么办](#5-出问题怎么办)，最省事是跟 AI 说「重打补丁」 |
| **看现在什么状态** | 点输入框上方的「破甲状态」胶囊，或说「跑 purge_status」。词看不懂查 [状态含义](docs/states.md) |
| **彻底卸掉** | [6. 卸载与还原](#6-卸载与还原) |
| **手机上为什么能动手** | [补丁层改了哪两处](#补丁层改了哪两处) 里那段「为什么手机上必须改审批」 |
| **和桌面版差什么** | [8. 差异](#8-差异) |
| **装的过程出岔子 / 装不起来** | [安装细节](docs/install.md) |

**章节索引和每个文件的用途在 [docs/structure.md](docs/structure.md)。**

---

## 1. 安装

### 让 AI 帮你装

把下面这一整段复制，发给能操作这台手机的 AI 助手（代码块右上角有复制按钮，一次拿全）：

```text
帮我把 https://github.com/NANA7MI0/dsh-purge-go 装到我这台手机上。
先跑 sh install.sh --dry 看一眼会改哪些文件，确认没问题再跑 sh install.sh。
装完告诉我补丁打了几条、插件版本是多少，重启由我自己操作。
```

（最后一句是故意的：重启会打断你手上的事，留给你自己决定什么时候做。）

如果助手要先问你一句「确认要我在这台手机上执行吗」，答一句「确认」就行——它问是因为安装过程会关掉引擎的人工确认环节（原因见[补丁层改了哪两处](#补丁层改了哪两处)里那段「为什么手机上必须改审批」），它想先得到你的明确同意。

### 也可以自己装

**此插件已经设计成用户安装可以不依赖任何自动化。**这台机器是你自己的，装不装、装完留不留这些文件、什么时候重启，都由你定。不想让助手代跑，或者它不愿意碰引擎源码，都可以自己来，App 自带终端（「全部功能」→「终端」）用户手动粘命令即可，命令见下文。

#### 第一步：打开终端

点侧栏的「全部功能」：

<img src="docs/app-all-features.jpg" width="300" alt="全部功能页：当前对话下面是对话详情、产出的文件、文件、终端、导出对话日志、后台任务等入口">

再点「终端」（工作区里的终端）：

<img src="docs/app-terminal.jpg" width="300" alt="终端界面：顶部 bash 标签，提示符 root@localhost:~/workspace#，底部一排 Esc/Tab/Ctrl/Alt 和方向键">

打开就是一个 bash，提示符长这样：

```text
root@localhost:~/workspace#
```

#### 第二步：粘命令、回车

要粘两条命令，一条装、一条重启。每条都是完整的一行，直接复制整行、粘进终端、按回车。

**第 1 条：安装**

```sh
git clone https://github.com/NANA7MI0/dsh-purge-go ~/dsh-purge-go && cd ~/dsh-purge-go && sh install.sh
```

三件事串在一起：下载仓库 → 进入目录 → 跑安装脚本。**前一步成功了才往下走**，所以中途出错不会在错误的目录里继续乱跑。

跑起来会逐步打印在做什么，十几秒到一两分钟（看网络）。**最后看到「装好了」这两个字，就是装完了：**

```text
════════════════════════════════════════
 装好了
════════════════════════════════════════

  注入层  ✔ 插件加载时自动落盘正文并开启
  补丁层  ✔ 已打到引擎包

▸ 最后一步：重启引擎让补丁生效
```

**第 2 条：重启**

补丁要重启引擎才生效。**不用敲命令，划掉 App 再打开就行：**

1. 从屏幕最底下往上划一下，调出「最近任务」
2. 找到这个 App 的卡片，往上划掉
3. 重新点图标打开

**关键是第 2 步要划掉**——只按返回键退到桌面不算，那样界面收起来了、引擎还在后台跑，补丁不生效。

**想在终端里一条命令搞定也可以**，粘这条回车：

```sh
am force-stop io.github.ccch1mneyyy.dsh_app
```

效果一样，之后同样要重新点图标。

#### 连不上 GitHub 怎么办

卡住不动、或报 `Failed to connect` / `Could not resolve host`：换成下面这条，它走 `codeload.github.com`——GitHub 的下载专用域名，有时比 `git clone` 通得快。

```sh
curl -L https://codeload.github.com/NANA7MI0/dsh-purge-go/tar.gz/refs/heads/main | tar xz && cd dsh-purge-go-main && sh install.sh
```

效果和上一条一样，只是解开的目录叫 `dsh-purge-go-main` 而不是 `dsh-purge-go`。

**报 `destination path already exists`**：说明 `~/dsh-purge-go` 已经在了，之前装过。不用删，直接跑这条（跳过下载，只跑安装；脚本是幂等的，装过再跑一遍也不会出问题）：

```sh
cd ~/dsh-purge-go && sh install.sh
```

#### install.sh 到底做了什么

连做四件事，次序是 **打补丁** → **建原生界面目录** → **藏掉 App 自带的「插件」胶囊** → **装插件**，做完提示你重启。**想先看会改哪些文件，把 `sh install.sh` 换成 `sh install.sh --dry`**：只扫描、预演，不装插件、不改引擎、不在仓库里留文件。

**装之前想看一眼的话，就这三点**（不看也能直接跑）：

1. **引擎版本必须是 0.2.x。** 0.3.x 装不上，会直接报 incompatible。要求写在 `package.json` 的 `engines.dsh` 里：`>=0.2.1-rc.2 <0.3.0-0`。查当前版本：`node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh-base/package.json').version"`。
2. **手机上没有任何沙箱后端**——bubblewrap、Landlock 在 Android proot 里都不存在，所以安装不经过审批或沙箱流程（原因见[补丁层改了哪两处](#补丁层改了哪两处)）。安装只做文件操作：把补丁写进 39 个引擎包里的**字符串常量**（不改逻辑、不加代码）、复制一份原生界面目录（1.1 MB）、在 profile 里注册插件。
3. **每一步都有备份，一条命令能撤**，见 [6. 卸载与还原](#6-卸载与还原)。

装到哪个目录都行，用 `~`（也就是 `$HOME`）而不是写死 `/root`——dsh-go 跑在 proot 里，`$HOME` 是 `/root`，但这个 root 是 proot 映射出来的**假身份**，真实进程属于 App 的 uid，**不需要任何 root 权限**；在普通 Linux 上 `$HOME` 是 `/home/你的用户名`，写死 `/root` 反而会失败。**但必须是持久目录**：`/tmp` 是内存盘（重启就清空），`/sdcard` 是 FAT32、没有执行位（所以文档统一写 `sh install.sh`，不需要执行权限）。

**插件永远排最后**，因为它是整条流程里唯一可能打断命令的步骤（`dsh plugin add` 会让宿主重新装配插件层）。补丁、原生目录和藏胶囊都是纯文件操作，放在前面——万一真被打断，这三样已经落地，不会出现「有插件、但没胶囊没面板」这种没法自己修的状态。早先的顺序是「补丁 → 插件 → 原生目录」，一旦插件那步被掐，用户拿到的是一个装上了却没有任何入口的插件，连点哪儿修都找不到。

> **第 2 步（建原生界面目录）只在手机端有意义。** 脚本靠 `/etc/dsh-app/runtime.json` 判断是不是 dsh-go，没有它就打印「这台机器没有 dsh-go 桥接，跳过原生界面目录」，不建也不会报错。dsh-go 的原生界面不在 profile 里，而在 `~/.dsh/dsh-go/plugins/dsh-go-purge/`——那一层由 app 自己扫，`dsh plugin add` 不管。脚本会把里面每一项**复制**一份进去（共约 1.1 MB），是独立副本而不是软链：仓库以后被删、被移走，这个目录仍然完整，App 照常启动。代价是 git pull 之后要再同步一次，点面板上的「更新」会自动做（拉代码 → 还原补丁 → 重打补丁 → 同步副本）。

> **不要用 npm 装。** npm 上的 `dsh-go-purge` 显示 `0.4.18`——那是 0.4.x 时代留下的旧版本，之后没再发布过（发布账号目前是 suspended 状态，提不了新版本）。用上面两条命令之一，才是当前版本。

参数表、分步截图、一条条手动敲的完整命令、以及从 0.5.x 之前升上来的注意事项，都在 [安装细节](docs/install.md)。

### 装完重启引擎

补丁要重启引擎才生效。**不用敲命令：从屏幕最底下往上划一下，把 App 的卡片划掉，再点图标打开即可。** Android 上没有服务管理，把进程杀掉再开就是这个效果。**关键是「划掉」**——只按返回键退到桌面不算，那样界面收起来了、引擎还在内存里跑着，插件不会重新加载。

终端里用命令也行，效果一样，之后同样要重新点图标：

```sh
am force-stop io.github.ccch1mneyyy.dsh_app
```

---

## 2. 它是什么

它由两层组成，缺一层都只是半套：

- **注入层**决定组装系统提示时哪几段进入上下文：`harness:identity` 与两段 persona 前缀/后缀不进入，留下工具定义、项目规则和你自己注入的正文。
- **补丁层**改执行侧的三个配置项：审批策略默认值、沙箱模式默认值、写权限提示文案（逐条见 [补丁层](docs/patches.md)）。

只有注入层，模型说得像但动不了手；只有补丁层，能动手但口气还是官方的。

**这两层各自的来源**：注入层（`lib/`）直接引用 [LanJinGod/dsh-purge-go](https://github.com/LanJinGod/dsh-purge-go)，本仓库只做 dsh-go 侧的路径适配；补丁层（`patches/`）的 86 条数据导出自社区维护版 [kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)（MIT），执行器和包名映射由本仓库实现。

### 补丁层改了哪两处

1. **审批策略的默认值**：`dsh-user-approval` 的 `policy` 默认值 `ask` → `never`，`ASK_SENTENCE` / `NEVER_SENTENCE` 两处文案改成 `auto-granted`——引擎用这两句话告诉模型「这次调用不需要等待确认」。它决定的只是「需要审批的操作会不会排队等应答」，不改任何其他行为。
2. **沙箱写权限的提示文本**：`dsh-sandbox-local` 的 `deny file-write*` 改成 `allow`。这是给模型看的一句话，不改它会以为自己不能写。

**为什么手机上必须改审批（前提，不是可选项）**：手机上引擎的 `ask` 策略没有可用应答器——引擎原文写死成「没有应答器时请求 fail closed」，也就是直接拒绝。桌面版 DSH 有交互式弹窗能应答，**dsh-go 没有**这套 UI，所以任何需要审批的操作在手机上必然失败：写文件、跑命令、改设置，一件都做不成。上游的处理方式就是把这一项从 fail-closed 改成 fail-open：没有应答器时按「已授予」处理——这是它能在手机上工作的唯一原因，不是可选项。想保留人工确认，按[可以只装一层](#可以只装一层)里的第 2 种装法。

> **作用范围**：只在引擎侧。工具输出（网页、文档、日志）按原样进入上下文，引擎不在模型与工具之间再介入一次。

### 沙箱：手机上和桌面上不是一回事

**代码层**：`dsh-sandbox-local` 里那些 `(allow file-write*)` 是 **macOS Seatbelt（SBPL）** 的规则语法，配合 `sandbox-exec` 生效。**Android proot 上没有这套后端**——bubblewrap、Landlock 在手机环境里都不可用（dsh-go 自己的文档也写着 `workspace-write` 模式一定会被拒绝）。**手机上的文件沙箱本来就是空的**，补丁改的那些规则在 Android 上从未执行过，打不打都一样。

**提示层**才是真的：起作用的是 `dsh-sandbox-policy` 里那句给模型看的话，补丁把它从拦截式表述换成「Continue the task; approval is auto-granted if a wider mode is needed」。

| 平台 | 补丁对沙箱的实际影响 |
|---|---|
| Android proot（本仓库目标） | **只改提示文本**，底层本来就没有沙箱后端 |
| macOS / 有 Seatbelt 的环境 | 真的改 SBPL 白名单，是实打实的放开 |

**结论：手机上这个补丁只是让模型不再被一句「read-only」吓住。文件能不能写，本来就不由它决定。**

### 关掉审批不会让注入失效

不会。这两件事在不同的层，互不干扰：

| | 在哪一层 | 关掉审批后 |
|---|---|---|
| 注入层（身份段丢弃、注入正文） | 组装系统提示时 | **照常生效**，一个字不改 |
| 审批（`policy`） | 工具调用前 | 按已授予处理，不进入等待状态 |

真实差别在**能不能动手**：对话、分析、写作、查资料，审批开或关都完全正常；写文件、跑命令、改设置只在审批关着时能成（开着时无应答器 → `unavailable` → 拒绝）。

**有个容易误判的地方**：审批开着时，被拒绝的结果会写进对话历史，模型看到 `rejected` 会改口说「我没有权限做这个」。看起来像「注入失效了」，其实提示词层毫发无损，只是工具用不了。

### 可以只装一层

1. **只要注入、不碰补丁层**：只装插件（`lib/`），**不跑 `purge-patch.mjs apply`**。注入层只改系统提示的组装，不碰审批和沙箱。
2. **只放开沙箱提示、保留审批**：手机上沙箱本来就没生效，放开它没有实际损失；这样能写文件，但需要审批的操作仍会走审批（前提是你自己解决「没有应答器」的问题）。
3. **两层都上**：跑过补丁层的 `apply` 之后，处理来路不明的网页/文档/日志时，留意里面可能夹带指令。

### 刻意不做的几件事

不是漏了，是权衡之后决定不做。

- **不移植原版的 Web 控制面板**（`dsh-purge-panel`，56 个文件、661 KB）：它走 DSH Web UI 的 slot 机制，**只在浏览器打开 `127.0.0.1:3080` 时才加载**；dsh-go 是 Flutter 原生界面，根本不加载 Web client 模块，那块面板在手机上永远不会出现。**不是「没有面板」，而是「没有 Web 版面板」**——0.5.0 起 App 里有功能等价的原生面板（见 [4. 面板与工具](#4-面板与工具)），两层数据都能在 App 里看、在 App 里操作。
- **不移植桌面工具链**：Electron、asar、Windows 控制台那套在 Android 上没有落点（对照表见 [8. 差异](#8-差异)）。
- **红队不放进本仓库**：它是独立 bundle，约 1.1 MB，上游是 [`Jueze-2019/dsh-redteam-mode`](https://github.com/Jueze-2019/dsh-redteam-mode)（MIT）。0.3.x 时以为它依赖原生 SQLite 和桌面 UI、在 dsh-go 里没有落点，这个判断是错的——它用的是 Node 内置 `node:sqlite`，面板用不了但工具层和资产库不依赖面板。0.4.0 起单独安装，装法见 [docs/redteam.md](docs/redteam.md)。
- **只适配 DeepSeek**：见下。

### 只适配 DeepSeek

**这个插件不改模型本身**，它改的是引擎——系统提示怎么组装、执行时有没有闸拦着。所以换 API 之后插件不是「失效」，而是分层受影响：注入层照常工作（走引擎的 `system-prompt/assemble`，跟用哪个模型无关）；补丁层里管审批、沙箱、身份、压缩的那批也照常工作（改的是 `node_modules` 里的源码）；只有 5 条模型相关补丁（`#47` / `#49` / `#52` / `#69` / `#72`）可能失效，不影响大局。

**真正的问题在注入正文的写法。** 包内那份正文（加密存成 `lib/asset-table.json`）第一行是：

```text
<|im_start|>system:<project_instructions>
```

`<|im_start|>` 是 **ChatML** 格式标记，DeepSeek / Qwen 系用这个。换到 Claude 或 GPT 上，它只是被当普通文本塞进 system，**不报错但也不加分**。这不是本仓库的疏忽——原版也是这么干的，社区维护版 v1.6.93 的 `lib/identity.js`、`lib/index.js`、`test/chatml-envelope.test.mjs` 等 10 个文件里都有 `im_start`。**结论：换模型的话插件该装还装，但别指望原封不动的效果，注入正文得按目标模型重写。**

---

## 3. 确认生效

**插件加载后即进入已启用状态**（`state.json` 里 `enabled: true`），不用先跑什么命令。启动时会落盘默认注入正文、把状态写成开启，系统提示里立刻开始丢身份段。**重启引擎就完事了**；下面这些工具是「管理入口」，用来查状态、换正文、关掉再打开，不是「必须先跑一遍」的步骤。

重启后开一个新会话（旧会话的 system 已写进历史，顶不动），任选一种确认：

```sh
# ① 看正文有没有自动落盘（约 27 KB，比包内那份大——会拼上题材分类扩展）
ls -l ~/.dsh/prompt-inject.md

# ② 看状态文件
cat ~/.dsh/dsh-purge/state.json            # 应该有 "enabled": true
```

> **注意别用 `$DSH_HOME`**：那个变量只在引擎进程里才有值，你手敲 shell 时是空的，`ls -l $DSH_HOME/...` 会变成 `ls -l /prompt-inject.md` 然后报 No such file。默认位置就是 `~/.dsh`；如果你改过 `DSH_HOME`，把它换成实际路径即可。

```sh
# ③ 让 AI 自查（最稳的一条）
# 在对话里说「跑 purge_status 看看状态」，它会调工具并把结果读给你
```

**最快的一条其实是点胶囊**：输入框上方那个「破甲状态」，点开就是面板，补丁层大数字直接写着 `57/57`，注入层五行也在。不用等 AI、不用敲命令。

---

## 4. 面板与工具

装好之后，对话里会多出六个工具：

| 工具 | 干什么 |
|---|---|
| `purge_status` | **看两层状态**：注入层（开关、正文来源与体积、当前变体、按模型指定、上次组装压掉哪些官方段）+ 补丁层（引擎路径、86 条的生效数与状态分布） |
| `purge_apply` | 重新开启破甲并确保正文存在。**装的时候已经自动做过一次**，只在关掉之后想重开、或正文丢了想补回来时用。`force=true` 覆盖重写 |
| `purge_revert` | 关闭破甲，把当前正文备份到 `dsh-purge/backups/`（正文本身保留） |
| `purge_prompt` | 读写注入正文与变体。`show` / `set` / `reset` / `use` / `default` / `map`（按模型指定变体） |
| `purge_category` | 题材分类扩展层。`list` / `add` / `rm` / `on` / `off` / `reset` / `bake` |
| `purge_patch_apply` | **打补丁层**。`apply`（打）/ `restore`（还原）/ `probe`（只看）。走子进程执行、带 120 秒超时，比面板按钮更稳，适合让 AI 代劳 |

**前五个管注入层，`purge_patch_apply` 管补丁层。** 除了工具还注册了斜杠命令 `/purge`，**手上没有 AI 时用它最方便**：`status` / `on` / `off` / `apply` / `revert` / `seed` / `prompt` / `variant` / `cat` / `home`，记不住就敲 `/purge help`，它会把全表打出来（只敲 `/purge` 等于 `/purge status`）。

### 面板长什么样

点输入框上方的「破甲状态」胶囊，直接打开的就是这一屏。**面板挂在三个地方**（同一份内容）：对话页签、聊天侧栏、App 的功能页，最常用的入口是胶囊。

<img src="docs/panel-status.jpg" width="360" alt="破甲状态面板：顶部一句总状态、补丁层 57/57、注入/正文/变体/模型/待办五行、四个按钮、下方明细表">

从上到下四块：

- **一句总结**：一句话概括两层状态，底色会变——正常绿底（「破甲能力完全正常。」）、有补丁没打上变黄、注入关了或补丁层被打穿变红。
- **补丁层**：一个大数字，比如 `57/57`（分子是本机已生效、分母是**手机适用的条数**，不是全部 86 条）；补丁大面积为未打时显示「未打」，不显示 `2/57` 那种容易误读的数。底下还有一行按实际拼的说明，如 `手机适用 57 条 · 已全部生效 · 另 29 条桌面专属`。
- **注入层五行**：`注入`（开/关）、`正文`（多少 KB）、`变体`、`模型`（当前模型）、`待办`（`没有要处理的` 或 `N 条要处理`）。
- **明细表**：按状态分表（可以再打 / 被升级冲掉 / 打不上 / 目标文件缺失 / 部分生效 / 无目标句 / 已生效 / 桌面专属），表头是 `#` / `补丁` / `说明`，说明列给一句「怎么办」；每张表最多列 20 行。

**四个按钮**（上限就是四个）：**重读**（重新扫一遍引擎刷新数字）、**一键注入**（先开注入、再顺手打补丁，**最常用**）、**开关注入**（只切注入层）、**还原补丁**（从最近的备份还原引擎文件，不重装引擎包）。面板每 30 秒自己刷新一次，点「重读」可以立刻刷。

> **别把面板和状态条搞混**：面板一直能开、你主动去看它；状态条（输入框上方那条横条）**只在出问题时自己出现**，正常时完全不显示，三句话都很短：`破甲未工作 · 点开修复`（两层都停）/ `破甲已关 · 点开恢复`（只关了注入）/ `破甲异常 · 点开处理`（补丁被冲掉）。两者读同一份数据，点状态条也是进同一个面板。

**不走界面也行**：面板能做的事命令行都能做——`node patches/purge-patch.mjs probe|apply|restore`，注入层开关用 `/purge on` / `/purge off`。完整的参数、`/purge` 命令全表、面板每一块的取数口径见 [工具与面板](docs/tools.md)。

---

## 5. 出问题怎么办

**① 补丁被 App 更新冲掉了（最常见）。** 升级引擎、或者装新版 App，都会把 `/opt/dsh/node_modules/@deepseek-ai/` 整个重铺一遍——实测 331 个包的时间戳全部刷新、补丁一条不剩。**这一点最容易被忽略**：你什么都没干，只是装了个新版 App，破甲就剩一半了。注入层不受影响（走官方扩展点），失效的只有补丁层。

判断：**输入框上方会自己冒出一条红色状态条**（正常时不显示，也不是点胶囊才出来的），点进去顶部写着「补丁被覆盖了（App 更新会重置引擎）」。

修复：说一句「重打补丁」让插件调 `purge_patch_apply`，或者手动跑：

```sh
cd ~/dsh-purge-go
node patches/purge-patch.mjs probe           # 先看命中率
node patches/purge-patch.mjs apply           # 再打
am force-stop io.github.ccch1mneyyy.dsh_app  # 重启才生效
```

命中率低说明查找串对不上，这种情况下 `apply` 会全部落空、文件不改（先 `probe` 看一遍即可）。

**② 看不懂面板上的数字和状态词。** `applied` / `hit` / `partial` / `drifted` / `no_pkg` / `no_needle` 的定义、`partial` 到底要不要管，见 [状态含义](docs/states.md)。判断破甲健不健康**只看 `applied` 的数量**：低于 10 条就判定被覆盖。**别用 `probe` 的数字判断「卸没卸干净」**——原版引擎上本来就有 `applied` 2 条、`hit` 30 条、`partial` 22 条，光看数字像是没卸干净。

**③ App 起不来（反复报 `start failed: ...dsh-go-purge/LICENSE`，连安全模式都救不回，App 内的终端也点不开）。** 0.6.8 起不会再进这个状态（原生界面目录改成独立副本，且装的时候先建到临时目录、全部校验通过才替换）。已经中招、但还能打开终端的话，一条命令修回来：

```sh
cd ~/dsh-purge-go && sh install.sh --repair-native
```

终端也点不开的三种救法（电脑 + USB / 手机有 root / 只能重装）见 [出问题时自查](docs/troubleshooting.md#app-起不来的时候怎么救)。

**④ 已知限制（改不了，只能绕）：**

- **只对新会话完全生效**：引擎把系统提示写进对话历史（`systemPromptUpdate: "in-history"`），旧会话里那条旧 system 还在，注入顶不动它。
- **压缩会重发基线**：上下文压缩之后，引擎会用 `COMPACT_AGENT_INSTRUCTIONS_INTRO` 那句弱提示顶掉强开场。想补的话**只改这一个常量**，**别去动 `REPLACEMENT_*`**——#2 补丁正把它们往「温和说法」的方向改，你再手动改强会和补丁互相覆盖。
- **补丁改的是 `node_modules`**：升级引擎、或者装新版 App，都会把它整个重装一遍、补丁全丢（见上面 ①）。
- **`node --check` 只验语法不验语义**：保证不把文件改坏，保证不了行为对。

**⑤ 还解决不了**：发邮件到 **NANA7MI0@outlook.com**，写清版本号、引擎版本、`probe` 输出和具体现象。完整自查清单和邮件模板见 [出问题时自查](docs/troubleshooting.md)。

---

## 6. 卸载与还原

> **卸载前先把这份 README 复制到仓库外**（`cp README.md ~/dsh-purge-readme.md`）——第 ③ 步会删掉整个仓库目录，手册和备份路径说明会跟着没。
>
> **即使仓库和备份都没了也救得回来**：下面的「备份没了」那条路不依赖仓库、不依赖备份，按 `/opt/dsh/package-lock.json` 重装原版包。

卸载有两层：第 ② 步只摘插件，第 ① 步 `restore` 才撤掉引擎里的补丁改动。**按顺序跑完，别跳步：**

```sh
# ① 还原补丁层（最容易漏，也最重要）
cd ~/dsh-purge-go
# 备份在哪取决于你怎么装的：install.sh 装 → ~/.dsh/dsh-purge/patch-backup/<时间戳>
#                             手动 CLI 打 → ./backup-<时间戳>
ls -d ~/.dsh/dsh-purge/patch-backup/* ./backup-* 2>/dev/null
node patches/purge-patch.mjs restore --backup <上面列出的最后一批>

# ② 从 profile 摘掉插件
dsh plugin --profile web remove dsh-go-purge

# ③ 删插件自己的文件
rm -rf ~/dsh-purge-go
rm -rf ~/.dsh/prompt-inject.md ~/.dsh/dsh-purge
rm -rf ~/.dsh/profiles/web/node_modules/dsh-go-purge

# ④ 删原生界面目录（0.3 起就有，卸载最容易漏的一项）
rm -rf ~/.dsh/dsh-go/plugins/dsh-go-purge

# ⑤ 重启引擎
am force-stop io.github.ccch1mneyyy.dsh_app
```

**为什么 ① 必须在 ② 之前**：`restore` 要用到仓库里的 `patches/`，删了仓库就没工具还原了。

每一层是什么、漏了会怎样：**补丁层**在 `/opt/dsh/node_modules/@deepseek-ai/` 下 39 个包里（`restore` 撤，漏了 `grep -r dsh-purge` 还能搜到）；**注入层**是 `~/.dsh/prompt-inject.md`（删文件，漏了每次开对话都往系统提示里塞正文）；**插件注册**在 `~/.dsh/profiles/web/package.json`（`dsh plugin remove`，漏了重启后插件又加载回来）；**插件文件**是仓库目录与 `node_modules` 软链（`rm -rf`）；**原生界面目录**是 `~/.dsh/dsh-go/plugins/dsh-go-purge/`（删掉不影响 App 启动）。

**怎么确认真的卸干净**（逐项核对，都不输出即为干净）：

```sh
# 补丁层：应该没有任何输出
grep -rl "dsh-purge" /opt/dsh/node_modules/@deepseek-ai/

# 关键文案：应该看到 rejected automatically
grep -o 'actions that require approval are rejected automatically' \
  /opt/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/child-agent.js

# 注入层与配置
ls ~/.dsh/ | grep -i 'purge\|prompt-inject'   # 应该为空

# 插件注册（应该输出 undefined）
node -p 'require(process.env.HOME+"/.dsh/profiles/web/package.json").dependencies["dsh-go-purge"]'

# 原生界面目录（应该不存在）
ls ~/.dsh/dsh-go/plugins/ 2>/dev/null    # 没有 dsh-go-purge 就算干净
```

判断是否真卸干净只有两条硬标准：**`grep -r 'dsh-purge' /opt/dsh/node_modules/@deepseek-ai/` 搜不到任何东西**，**关键文案是原版**。

### 还原引擎：有备份 / 备份没了

补丁打的是 39 个包，还原取决于你手上还有没有 `apply` 时的备份。

- **有备份**：`apply` 每次生成一个 `backup-<时间戳>/files/`（CLI 跑在仓库目录，`install.sh` 装的在 `~/.dsh/dsh-purge/patch-backup/`），里面是被改过文件的原始副本。按时间倒序撤（后打的先撤）：

  ```sh
  cd ~/dsh-purge-go
  node patches/purge-patch.mjs restore --backup ./backup-<最后一批>
  node patches/purge-patch.mjs restore --backup ./backup-<更早一批>
  ```

  同一文件可能被多批补丁动过，先撤早的会被后撤的覆盖，最后停在混合状态——所以要倒序全跑完。还原前会核对引擎版本（备份里记着 `engine.version`），版本换过会拒绝，这不是多此一举：把旧版引擎的文件写进新版里，轻则补丁失效、重则引擎起不来。
- **备份没了**：把原版包重新装回来——按 `/opt/dsh/package-lock.json` 跑 `cd /opt/dsh && npm install --force`（不需要知道哪些包被改过），或者只重装被改的那 39 个包。完整脚本、逐字节比对验证、备份版本核对见 [还原引擎](docs/restore.md)。

### 还原后必须重启

```sh
am force-stop io.github.ccch1mneyyy.dsh_app
```

**不重启的话，跑着的引擎进程里加载的还是旧代码**，文件改了也白改。

---

## 7. 环境

| 项 | 值 |
|---|---|
| 引擎版本 | **0.2.2-rc.1**（实测基线） |
| 引擎路径 | `/opt/dsh`，包目录 `node_modules/@deepseek-ai` |
| 宿主 | Android，proot 内 Ubuntu，**不需要 root** |
| Node | 20+（用到 `node --check` 和 ESM） |
| **包管理器** | **pnpm**（`dsh plugin` 底层就是调 pnpm，缺了会报 `dsh: pnpm was not found`） |
| 运行时依赖 | 零。插件本身只用 Node 内置模块 |
| 体积 | 55 个文件 / 约 1.05 MB（含截图与文档） |

**引擎版本适配表**（这张表同时决定「点一键注入」和「点还原」会不会被拦）：

| 引擎版本 | 状态 | 说明 |
|---|---|---|
| **`0.2.2-rc.1`** | **✅ 已适配** | **当前唯一实测基线。App 1.2.0 自带的就是这一版** |
| 其他 0.2.x | ⚠️ 未适配 | 引擎版本一变，还原会被拒绝并提示「别点一键注入，可能崩引擎」 |
| 0.3.x 及以上 | ❌ 装不上 | `package.json` 的 `engines.dsh` 拦着，`dsh plugin add` 直接报 incompatible |

`engines.dsh` 写的是 `>=0.2.1-rc.2 <0.3.0-0`（`-0` 表示排除 0.3.x 的预发布版）。真要试 0.3.x，就按 `dsh plugin add` 报错里给的那行 `allow-version ... --accept-risk` 敲，**三个参数一个都不能少**；但补丁层的查找串大概率对不上，**先 `probe`，别直接 `apply`**。适配新引擎版本、改 `SUPPORTED_ENGINES`、三种拦截情形怎么判，都在 [补丁层](docs/patches.md#引擎版本适配表)。

---

## 8. 差异

**和桌面版 `kingcharleslzy-ai/dsh-purge` 的差别：**

| 项 | 桌面版 | 本仓库 |
|---|---|---|
| 目标 | PC 上的 DSH | dsh-go |
| 注入方式 | 自带 `core.js`（177 KB，补丁表已拆去 `lib/patches/`），逐句改写系统提示 | 在装配环节整段替换 |
| 规模 | 518 文件 / 305 个 js+mjs / 4.83 MB | **55 文件 / 约 1.05 MB**（插件代码 4,461 行） |
| 补丁 | 自带（`lib/patches/` 拆成 6 个模块，83 条） | 导成 `patches.json`（86 条）+ 独立执行器 |
| 桌面功能 | asar 解包、计划任务 | 无 |
| 面板 | `packages/purge-panel/` 独立 Web 面板 | 原生面板（Web 版不移植，理由见[刻意不做的几件事](#刻意不做的几件事)） |
| 许可 | MIT（社区版） | AGPL-3.0（因注入层是 AGPL） |

**定位：只保留破甲，桌面版其余功能全部放弃。** 原版是**桌面版**（518 个文件、4.83 MB），本仓库只取其中跟「破甲」直接相关的两件事——提示词注入内核、引擎源码补丁。`client.js`（662 KB，依赖 `window.__ModuleLoader__`，引擎 node 进程里没有 `window`）、`packages/purge-panel/`（Web 面板）、`desktop.js` / `extract-asar.js` / `hide-console.js` / `host-clean.js`（Electron、asar、Windows 控制台的宿主适配）、`hooks-deny.js`（依赖桌面版的 hooks 目录结构）全部丢弃；`continue-retry.js` / `anchor.js` 的功能本身有用，但注入层用另一种方式（`lib/recover.js`）解决了同一件事。

**为什么这么砍**：手机引擎只有 `systemPrompt` / `tools` / `commands` 这几个服务，桌面版一大半代码在这里没有落点，留着只会增加体积和出错面。砍完剩下的就是「破甲」这一件事——让引擎组装系统提示时不再带官方身份，让执行侧的默认配置项不再挡住工具调用。这也是这个仓库存在的唯一理由。

---

## 9. 来源

| 部分 | 作者 |
|---|---|
| `lib/` | [LanJinGod/dsh-purge-go](https://github.com/LanJinGod/dsh-purge-go)，直接引用，本仓库只做 dsh-go 侧路径适配 |
| `assets/categories.json` | 同上 |
| `lib/asset-table.json`（正文加密副本） | 同上的正文，本仓库加了题材分类扩展的 4 行标记后重新打包 |
| `patches/patches.json` | dsh-purge 社区维护版作者 小杨 / YuJunZhiXue（数据导出自 [kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) v1.6.93，MIT） |
| `patches/purge-patch.mjs`、README、包名映射 | 本仓库 |

仓库挂在 `NANA7MI0` 名下只代表谁维护这份适配，不代表注入层或补丁设计归他。

许可证 **AGPL-3.0**（0.2.x 是 MIT，0.3.0 换注入层后按 AGPL 传染性改了）。

**配套红队插件**是独立 bundle（上游 [`Jueze-2019/dsh-redteam-mode`](https://github.com/Jueze-2019/dsh-redteam-mode)，MIT），单独的仓库、单独的装法，不装完全不影响破甲。装法、它包含什么、装完怎么验、已知的上游问题都写在 [docs/redteam.md](docs/redteam.md)。

**遇到问题**：装不上、面板报错、补丁打不上、行为跟文档对不上——先按对应章节自查（安装问题看 [安装](docs/install.md)，补丁看 [补丁层](docs/patches.md)，状态看不懂查 [状态含义](docs/states.md)）；还解决不了，发邮件到 **NANA7MI0@outlook.com**，要写清哪些东西见 [出问题时自查](docs/troubleshooting.md#遇到问题)。

其他入口：目录与文件结构见 [docs/structure.md](docs/structure.md)，每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。
