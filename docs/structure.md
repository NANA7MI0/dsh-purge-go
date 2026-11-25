# 目录与文件结构

> 原 README 的「19. 目录」与「20. 文件结构」两章合并到这里（19 章的章节索引按新编号重做过），再加「21. 更新日志」的说明。

## 章节索引

README 现在只有 9 章，从「安装」一路读到「来源」即可。下面的链接直接跳到 README 对应小节。

- [快速导航](../README.md#快速导航)
- [1. 安装](../README.md#1-安装)
  - [装完重启引擎](../README.md#装完重启引擎)
- [2. 它是什么](../README.md#2-它是什么)
  - [补丁层改了哪两处](../README.md#补丁层改了哪两处)
  - [沙箱：手机上和桌面上不是一回事](../README.md#沙箱手机上和桌面上不是一回事)
  - [关掉审批不会让注入失效](../README.md#关掉审批不会让注入失效)
  - [可以只装一层](../README.md#可以只装一层)
  - [刻意不做的几件事](../README.md#刻意不做的几件事)
  - [只适配 DeepSeek](../README.md#只适配-deepseek)
- [3. 确认生效](../README.md#3-确认生效)
- [4. 面板与工具](../README.md#4-面板与工具)
  - [面板长什么样](../README.md#面板长什么样)
- [5. 出问题怎么办](../README.md#5-出问题怎么办)
- [6. 卸载与还原](../README.md#6-卸载与还原)
  - [还原引擎：有备份 / 备份没了](../README.md#还原引擎有备份--备份没了)
  - [还原后必须重启](../README.md#还原后必须重启)
- [7. 环境](../README.md#7-环境)
- [8. 差异](../README.md#8-差异)
- [9. 来源](../README.md#9-来源)

**docs/ 下的说明**（README 里只留一行指针，细节都在这几份里）：

| 文件 | 讲什么 |
|---|---|
| [install.md](install.md) | `install.sh` 参数表、App 终端分步与截图、一条条手动敲的命令、从 0.5.x 之前升级、怎么重启引擎 |
| [tools.md](tools.md) | 6 个工具与 `/purge` 命令全表、面板每一块的取数口径、注入正文为什么加密存 |
| [patches.md](patches.md) | 补丁怎么打/怎么还原、87 条命中情况、关键补丁表、引擎版本适配与拦截 |
| [states.md](states.md) | `applied` / `hit` / `partial` / `drifted` / `no_pkg` 这些状态词的定义，`partial` 到底要不要管 |
| [restore.md](restore.md) | 还原引擎的完整命令：有备份走 restore、没备份从 npm 重装、逐字节验证 |
| [troubleshooting.md](troubleshooting.md) | 已知限制、App 起不来的三种救法、App 更新后重打补丁、报障模板 |
| [redteam.md](redteam.md) | 配套红队插件（独立 bundle）的装法、验证与已知上游 bug |
| [history-scrub.md](history-scrub.md) | 历史清洗（补丁层第 87 条）：判断有多严、什么时候不生效、怎么关、怎么确认在跑 |

## 文件结构

**文件**

```
docs/             截图 3 张（panel-status.jpg 面板 · app-all-features.jpg 与 app-terminal.jpg 安装步骤）
                  + 说明 8 份（install / tools / patches / states / restore / troubleshooting / structure / redteam）
lib/              注入层与原生界面：26 个 .js 模块 + 2 个数据文件（早期部分模块来自 LanJinGod，其余是本仓库加的）
  asset-table.json  正文密文（原始 md 不进仓库，解出来的办法见 docs/tools.md）
  backup-files.js   备份缺哪些文件（prepare 与 topup 共用这一份，别再造第二份）
assets/           只在本机开发时存在（categories.json、default-prompt.md 明文源，都不进 git）。
                  全新 clone / npm 包里没有这个目录；运行时装的是 lib/ 下的两份密文产物。
patches/          patches.json（87 条）
  purge-patch.mjs   CLI 壳（只做参数解析与输出；每次结束打一行 __RESULT__ {json} 给 install.sh 判断分支）
  lib/core.mjs      纯函数库（probe / apply / restore / isDone / verifyFile）
  lib/settle-steps.mjs  更新后的收尾六步（settle.mjs 与 update-worker.mjs 共用同一份）
  lib/replace-repo.sh   用新代码整份替换仓库（面板、worker、归档更新共用；先铺新的再删多余的，中途被打断也能启动）
  update-archive.sh     连不上 github.com 时的归档更新入口（下载 → 解包 → 调 replace-repo.sh → 跑 install.sh）
scripts/          engine-smoke.mjs（段注册与 assemble 重排验证）· kit-check.mjs（插件规范检查，需外部 plugin-kit）
                  · embed-default-prompt.mjs（正文打包）· dump-prompt.sh（打印注入正文明文）
test/             15 个文件，分三类：
                    · 单元测试 12 个（*.test.js，node --test 跑）
                    · 场景测试 scenarios.mjs（造真实故障状态，验用户看到的那句话对不对）
                    · 一致性检查 consistency.mjs（版本号 / 面板描述 / 补丁数字 / 状态词 /
                      工具名 / 文件结构 / README 锚点 / 跨文件锚点，逐项与代码对照。
                      注意它查的是「数字与锚点」，不查散文描述是否还准确——改行为后要自己核文案）
install.sh        一键装：打补丁 → 建原生界面目录 → 写 ui.json 隐藏旧胶囊 → 装插件
cordis.patch.yml  插件插入声明
package.json      清单（name / version / engines.dsh / dsh.bundle.patch）
LICENSE           AGPL-3.0 全文
NOTICE            三部分来源与各自许可
README.md         总览（9 章）
CHANGELOG.md      更新日志（每个版本改了什么）
.gitignore        排除 backup-*/ 、patch-probe.json 这类运行时产物
```

合计 **78 个文件、约 1.2 MB**（`git ls-files` 全量，含 `docs/` 下 3 张截图与 9 份说明；体积会随版本小幅变化）。

**运行时才会出现的（不进 git，`ls` 能看到别以为多了）：**

| 路径 | 什么时候有 | 能不能删 |
|---|---|---|
| `backup-<时间戳>/` | 直接跑 `purge-patch.mjs apply` 时生成，每次一份 | **别删**——这是还原补丁的唯一凭据，删了就只能重装引擎包 |
| `patch-probe.json` | 手动跑 `probe` 时写在当前目录 | 可以删，下次 probe 会重写 |
| `~/.dsh/dsh-purge/patch-backup/` | 用 `install.sh` 装时备份存这儿（不在仓库目录） | **别删**，同上 |
| `~/.dsh/dsh-purge/` | 插件的运行数据：开关状态、正文来源、变体、诊断日志 | 删了等于恢复出厂，注入会重新落盘默认正文 |

改 `lib/` 之后必须重启引擎；改 `package.json` 会被热读。

> 红队的 `skills/` 和 `presets/` **不在本仓库**——那套是独立 bundle，见 [redteam.md](redteam.md)。
> 早期版本带过 23 个技能和 3 个预设（238 KB）：0.3.2 删掉了，0.4.0 改成另外装，
> 所以本仓库目录里不会再有它们。0.4.0 时文件数与体积从 35 / 0.87 MB 长到 37 / 1.0 MB
> （多了 `patches/lib/core.mjs` 和 `test/core.test.js`）；0.4.8 删掉 region 门之后回到 35 / 605 KB。

## 更新日志

每个版本改了什么，见 [CHANGELOG.md](../CHANGELOG.md)。

格式约定：一条只写用户能感知的现象，不写实现细节。
