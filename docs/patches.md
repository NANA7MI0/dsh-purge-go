# 补丁层：怎么打、打的是什么

> 本文原为 README 的「8. 关键补丁」整章，加上原本散在「2.5 打补丁」「2.5.1 命中情况」「13.1 引擎版本适配表」「6. 为什么手机上必须改审批」末尾的补丁细节。
> README 只留结论，逐条核对看这里。

## 怎么打、怎么还原

```sh
node patches/purge-patch.mjs probe            # 扫描：哪些能打、哪些版本不匹配（会在当前目录写 patch-probe.json）
node patches/purge-patch.mjs apply --dry      # 预演：会改哪些文件
node patches/purge-patch.mjs apply            # 真打
node patches/purge-patch.mjs restore --backup <备份目录>
```

**全程可逆**：`apply` 先把要改的文件复制到 `backup-<时间戳>/files/`（CLI 跑时在仓库目录，`install.sh` 装时在 `~/.dsh/dsh-purge/patch-backup/`），同时生成 `restore.sh`。每个 `.js` 改完立刻 `node --check`，语法不过就当场还原，不留半成品。

`--root` 或环境变量 `DSH_AI_ROOT` 可指定引擎包目录，默认自动探测。补丁会改 41 个引擎包、**必须重启引擎才生效**。

## 86 条补丁的命中情况

> 下表是 **dsh-go 0.2.2-rc.1 + dsh-purge-go、已 apply 过**的本机读数。你的机器可能不同，以 `probe` 为准。状态词的准确定义在 [状态含义](states.md)。

| 状态 | 条数 | 意味着 |
|---|---|---|
| `applied` | **58** | 所有目标包都打过了（另有 #2/#3 两条反向补丁也算「满足」，但它们不改任何文件，已从下面的数字里剔除） |
| `no_pkg` | 26 | 目标包手机上根本没有（见下） |
| `partial` | 0 | 本机没有。某条只命中了多套写法里的一套时才会出现，含义见 [状态含义](states.md) |

**86 条里，手机上有目标的有 58 条是真的会改动文件，全部生效。** 面板上写着 `58/58`，分子分母相等。

`partial` 算不算生效要分情况看——它字面意思是「改了一部分」，**大多数时候是没改全**，不能一概当正常（详见 [状态含义](states.md)）。本机当前没有 `partial`，所以这里不存在歧义。

那个计数只反映「条目打没打上」，不是破甲强度的折扣——破甲靠的是注入层和审批/沙箱那批，它们在正常工作的 58 条里。

**26 条 `no_pkg` 不是移植失败，是它们要改的包手机上根本没有。** dsh-go 不是桌面版裁出来的，是另一套运行形态：桌面版跑在 Electron 里有 `app.asar`、有预设切换、有 Desktop Shell 管进程；手机版跑在 proot 里只有一个 node 进程，能力由 `dsh-base` 一套配置决定。

| 类别 | 条数 | 为什么手机没有 |
|---|---|---|
| preset 预设包 | 8 | 桌面版靠预设包切换能力，手机只跑 `dsh-base` |
| desktop-shell | 7 | 手机没有 Electron 外壳 |
| hooks 兼容层 | 4 | 手机没有 Claude Code / Codex 这些编辑器 |
| escalation | 4 | 桌面版把审批拆成独立模块，手机是单包 |
| pi-ai / PTC / 其他 | 3 | 手机只连 DeepSeek、跑 proot，没有那套沙箱与适配层 |

**有些包在桌面版和手机版叫法不同**（`user-approval-invariant` → `dsh-user-approval` 等），这批没丢：`patches.json` 里这些补丁的 `file` 字段并列写了两个名字，执行器 `candidatesFor()` 挨个试，哪个存在用哪个。所以 #5 这类显示的是 `applied` 而不是 `no_pkg`。

**一句话总结**：86 条里 58 条在手机上真能改，破甲靠的就是这批。

## 为什么手机上必须改审批（引擎原文）

**手机上引擎的 `ask` 策略没有可用应答器。** 引擎原文写死成：没有应答器时请求 fail closed——也就是直接拒绝。

```text
Approval policy: ask. Operations that require approval may ask through the
configured answerers; without an available answerer, the request fails closed.
```

桌面版 DSH 有交互式弹窗能应答，**dsh-go 没有**这套 UI。所以任何需要审批的操作在手机上必然失败——
写文件、跑命令、改设置，一件都做不成。

上游的处理方式是把这一项从 fail-closed 改成 fail-open：没有应答器时按「已授予」处理。
**这是它能在手机上工作的前提，不是可选项。**


**不想全改**：按 [README 的「可以只装一层」](../README.md#可以只装一层) 第 2 种装法，只放开沙箱提示、保留审批。

## 关键补丁

86 条覆盖提示词、代码、工具、兼容四类。

**下面这张表里的名字是 `patches.json` 里的原始命名，照录以便逐条核对。**名字描述的是每条补丁改的配置项，不是本文档对使用者的建议——完整 86 条见 `patches/patches.json`。最要紧的几条：

**先说一句结论，再看表：手机上真正会执行到的，只有审批那一组。沙箱那几条改的是 macOS 的规则语法（SBPL），Android proot 里根本没有执行后端——它们在手机上等于没生效，只是把给模型看的那句话从 read-only 改成了允许。详见 [沙箱：手机上和桌面上不是一回事](../README.md#沙箱手机上和桌面上不是一回事)。**

| id | 名字 | 改的是什么 | 手机上实际影响 |
|---|---|---|---|
| 5 / 8 / 9 / 10 / 11 | `APPROVAL_NEVER_SENTENCE` / `APPROVAL_POLICY_DEFAULT` / `APPROVAL_AUTO_GRANT` / `APPROVAL_CONFIG_DEFAULT_NEVER` / `APPROVAL_NEVER_SENTENCE_BYPASS` | 审批策略默认值 `ask` → `never`，两处提示文案改成 `auto-granted` | **生效**：需要审批的操作改为直接执行（原因见 [它是什么](../README.md#2-它是什么)） |
| 6 | `SANDBOX_DENY_FILE_WRITE` | SBPL 规则 `(deny file-write*)` → `(allow file-write*)` | 规则不执行；只改模型看到的那句话 |
| 7 | `SANDBOX_MODE_DEFAULT` | 沙箱 mode 默认值 `workspace-write` → `danger-full-access` | 同上，Android 上没有可用的沙箱后端 |
| 15 | `SANDBOX_CONFINE_PASSTHROUGH` | `confine(argv, policy)` 直接返回 | 同上，手机上这个函数没有调用点 |
| 25 | `HARNESS_IDENTITY_STRIP` | `includeHarnessIdentity` 默认 `false` | **生效**：系统提示不再带官方身份段 |
| 55 / 66 / 67 / 68 / 72 | `SYSTEM_PROMPT_REPLACE_HEAD` / `SYSTEM_PROMPT_RENDER_GUARD` / `AGENT_LOOP_MESSAGES_GUARD` / `SYSTEM_NODES_CONTENT_GUARD` / `MESSAGES_SYSTEM_CURRENT` | 装配守卫与消息守卫（名字不全是 `SYSTEM_PROMPT_*` 前缀） | **生效**：决定装配时哪几段进入上下文 |
| 58 / 75 | `REWIND_SKIP_DERIVE` / `REWIND_RESET_TODOS` | 回退空标记不进模型请求、回退重置未完成任务 | **生效** |
| 87 | `HUNG_PROMPT_LF_NEEDLE` | 空白宿主的挂载比对改用 LF，避免 CRLF 误判（**不是 REWIND**） | **生效** |

## 补丁编号

86 条，历史编号最大到 93，中间空了 7 个（#20 #21 #27 #41 #44 #79 #81，已删除或合并）。
86 条覆盖提示词、代码、工具、兼容四类，最要紧的几条见上面的[关键补丁](#关键补丁)。

## 引擎版本适配表

**这张表同时决定「点一键注入」和「点还原」会不会被拦**。注入前先看引擎版本在不在表里：不在就拒绝，不备份也不打——补丁是照旧版源码写的，硬打可能让引擎起不来。还原前再比对备份记的引擎版本和 App 版本，对不上同样拒绝，按下面三种情况给不同提示。

| 引擎版本 | 状态 | 说明 |
|---|---|---|
| **`0.2.2-rc.1`** | **✅ 已适配** | **当前唯一实测基线。App 1.2.0 自带的就是这一版** |
| 其他 0.2.x | ⚠️ 未适配 | 引擎版本一变，还原会被拒绝并提示「别点一键注入，可能崩引擎」 |
| 0.3.x 及以上 | ❌ 装不上 | `package.json` 的 `engines.dsh` 拦着，`dsh plugin add` 直接报 incompatible |

**这个表在哪生效**：代码里是 `patches/lib/core.mjs` 的 `SUPPORTED_ENGINES` 常量。

```js
export const SUPPORTED_ENGINES = ['0.2.2-rc.1']
```

**适配了新引擎版本之后**：往这个数组里加一项，再把上面表格改一行，两处保持一致。

**App 或引擎更新之后，两个按钮分别会怎么拦：**

| 情况 | 点「一键注入」 | 点「还原补丁」 |
|---|---|---|
| **App 更新了，引擎没变** | **放行**：先备份、再打补丁 | **拒绝**，提示「App 更新过了，点一键注入重建备份」 |
| **引擎变了，且在新表里** | **放行**：先备份、再打补丁 | **拒绝**，提示「引擎版本已适配，点一键注入重打一次就行」 |
| **引擎变了，且不在表里** | **拒绝**，提示「引擎版本没适配，别注入（可能崩）」 | **拒绝**，同样不给还原 |

**第三种情况是唯一「两个按钮都不让点」的**：补丁是照旧版源码写的，硬打可能改出半截代码、让引擎起不来。这时只能等插件发新版适配，或者按 [还原引擎](restore.md) 把引擎包重装回适配的版本。

**引擎版本边界**：`package.json` 里写的是 `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`（`-0` 表示排除 0.3.x 的预发布版）。
引擎升到 0.3.x 之后 `dsh plugin add` 会**直接拒绝安装**：

```
dsh: to accept the risk, run: dsh plugin --profile web allow-version dsh-go-purge@<版本> --dsh-version <当前引擎版本> --accept-risk
dsh: plugin command failed; diagnostics: ...
```

真要试就照它给的那行敲，**三个参数一个都不能少**（`包名@版本`、`--dsh-version <精确版本>`、`--accept-risk`）。
但补丁层的查找串大概率对不上，先跑 `probe` 看命中率。

别的引擎版本也是同理：**先 `probe`，别直接 `apply`**。

## 退出码与 kind

`patches/purge-patch.mjs` 每次跑完，往 **stderr** 打一行机器可读的结果：

```
__RESULT__ {"ok":false,"command":"apply","applied":0,"errors":1,"kind":"engine_unsupported"}
```

`install.sh` 只读这一行判断走哪个分支，**不再比对中文提示**。以前靠 `grep '还留着上次打的补丁'`
这类文案判分支，改一句提示就静默走错，最后落到 else 说「引擎可能已被部分修改」，把人吓去白重装引擎。

**kind 取值：**

| kind | 什么情况 | 引擎状态 |
|---|---|---|
| `ok` | 全成功 | 已打上 |
| `engine_unsupported` | 引擎版本不在 `SUPPORTED_ENGINES` 里 | **一个字节都没动** |
| `dirty_engine` | 引擎里还留着上次的补丁，不能存成原始状态 | 保持原样（本来就有补丁） |
| `incomplete_backup` | 找到的备份缺文件 | **一个字节都没动** |
| `restore_partial` | 还原到一半出错（抛异常或有文件没还原成） | **可能停在半截**，建议重装引擎包 |
| `rollback_incomplete` | 打到一半失败、回滚也没滚干净 | **可能停在半截** |
| `apply_errors` | 一般的打补丁失败 | 看日志 |
| `apply_failed` | `core.apply` 直接抛异常 | 不确定 |
| `restore_empty` | 还原执行了但没还原任何文件 | 没变 |
| `no_root` | 找不到引擎目录 | 没动 |
| `unknown_command` | 子命令拼错 | 没动 |

**新增 kind 时两处都要改**：`patches/purge-patch.mjs` 里 emit 的地方，和 `install.sh` 里对应的分支。

## 补备份为什么必须在还原之前

补丁目标会长大（0.7.0 加了 presets、ptc、pipeline.js）。备份是打补丁那一刻建的，
只包含当时的目标。老备份还原时「47 个目标只覆盖 41 个」，剩下 6 个永远带着补丁标记。

`prepareBackup`（`lib/prepare.js`）会从 npm 把缺的原始文件拉回来补进备份。它必须排在最前：

```
补备份 → 找可复用的备份 → 校验完整性 → 还原 → 重打
```

**面板那条路（`patches/update-worker.mjs`）一直有这一步，CLI 之前没有** —— 于是
用户照 README 跑 `git pull && sh install.sh` 时补丁一条都打不上、只把插件装好；
点面板的「更新」按钮却是好的。两边现在都做，`--no-topup` 可以关掉（排障用）。

**选哪份备份也是共用的**：`prepareBackup` 和 `findReusableBackup` 用同一个判断，
否则「补的是最新那份、用的是最早那份」，补了个寂寞。