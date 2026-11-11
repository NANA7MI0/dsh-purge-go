#!/usr/bin/env bash
# dsh-purge-go 一键发布到 GitHub（建仓库 / 推 main + tag / 建 Release / 传资产）。
#
# 常用：
#   bash scripts/publish-github.sh --dry-run        # 只打印计划：不联网、不改文件、不需要 token
#   GITHUB_TOKEN=ghp_xxx bash scripts/publish-github.sh
#   bash scripts/publish-github.sh --bundle         # 离线：产出 dist/*.bundle + dist/*-src.zip
#
# 环境变量：
#   GITHUB_TOKEN   真实发布必需。classic token 勾 repo 即可（组织仓库再加 read:org）。
#   GITHUB_OWNER   仓库 owner；不填就用 token 调 GET /user 取 login。
#   REPO           仓库名，默认 dsh-purge-go。
#   VISIBILITY     public（默认）| private | internal。
#   TAG            发布 tag，默认 v<package.json 的 version>。
#   GITHUB_API_URL / GITHUB_UPLOAD_URL   GHES 用；默认 api.github.com / uploads.github.com。
#
# 设计要点：
#   · set -euo pipefail；全程不开 set -x。token 只出现在 curl 的 -H 头和一次性 push URL 里，
#     所有回显都过 redact()，任何分支都不会把 token 打进日志或 .git/config。
#   · 有 gh 且已登录 → 走 gh；否则纯 curl + REST（无 gh 也能发）。
#   · 幂等：仓库已存在不报错；Release 已存在走 PATCH；同名资产先删后传；tag 已一致就跳过。
#   · bash 3.2 兼容（macOS 默认 bash）：没有关联数组、没有 ${var,,}、没有 mapfile。
set -euo pipefail

# ---------------------------------------------------------------------------
# 常量 / 全局状态
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

PKG="dsh-purge-go"
BRANCH="main"
API_BASE="${GITHUB_API_URL:-https://api.github.com}"
UPLOAD_BASE="${GITHUB_UPLOAD_URL:-https://uploads.github.com}"
GIT_NAME="dsh-purge-go release"
GIT_EMAIL="release@localhost"

DRY_RUN=0
BUNDLE=0
OWNER_IS_ORG=0

TOKEN="${GITHUB_TOKEN:-}"
OWNER="${GITHUB_OWNER:-}"
REPO="${REPO:-dsh-purge-go}"
VISIBILITY="${VISIBILITY:-public}"
TAG="${TAG:-}"

DESC=""
NOTES_FILE=""
RELEASE_ID=""
API_STATUS="000"
API_BODY="{}"
LAST_CURL_ERR=""

# 占位符：dry-run / 无 token 时用于打印计划，确保任何日志里都不会出现真 token
OWNER_PLACEHOLDER="<owner>"
TOKEN_PLACEHOLDER="<GITHUB_TOKEN>"

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
step() { printf '\n==> %s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
dsh-purge-go 发布脚本

用法：
  bash scripts/publish-github.sh [选项]

选项：
  --dry-run     只打印将执行的命令与 API，不联网、不改任何文件（也不需要 token）
  --bundle      离线模式：产出 dist/dsh-purge-go-<ver>.bundle 与 dist/dsh-purge-go-<ver>-src.zip
  --org         GITHUB_OWNER 是组织：建仓走 POST /orgs/{owner}/repos
  --private     建私有仓库（等价 VISIBILITY=private）
  -h, --help    显示本帮助

环境变量：GITHUB_TOKEN（真实发布必需）、GITHUB_OWNER、REPO、VISIBILITY、TAG。
EOF
}

# 把字符串里的 token 换成 ***；token 为空或还是占位符时原样返回
redact() {
  local s="$1"
  if [ -z "${TOKEN:-}" ] || [ "$TOKEN" = "$TOKEN_PLACEHOLDER" ]; then
    printf '%s' "$s"
    return 0
  fi
  printf '%s' "${s//"$TOKEN"/***}"
}

# 执行命令并回显（回显脱敏）；dry-run 只打印
run() {
  local shown
  shown="$(redact "$*")"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$shown"
    return 0
  fi
  printf '  $ %s\n' "$shown"
  "$@"
}

# ---------------------------------------------------------------------------
# JSON 小工具（用 node 解析/生成，避免手写转义踩坑；本包本来就要求 node）
# ---------------------------------------------------------------------------
json_get() {
  # 从 stdin 的 JSON 取点号路径字段，取不到就输出空串
  node -e '
let raw = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  try {
    const obj = JSON.parse(raw)
    const val = process.argv[1]
      .split(".")
      .reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), obj)
    if (val !== undefined && val !== null) process.stdout.write(String(val))
  } catch (err) {
    process.exit(0)
  }
})
' "$1"
}

json_asset_id() {
  # 从 stdin 的资产列表里按名字取 id
  node -e '
let raw = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return
    const hit = list.filter((item) => item && item.name === process.argv[1])[0]
    if (hit) process.stdout.write(String(hit.id))
  } catch (err) {
    process.exit(0)
  }
})
' "$1"
}

repo_json() {
  # 建仓载荷：private 由 VISIBILITY 决定；描述取 package.json 的 description（截 300 字）
  local priv="0"
  [ "$VISIBILITY" = "public" ] || priv="1"
  node -e '
const name = process.argv[1]
const priv = process.argv[2] === "1"
const desc = process.argv[3] || ""
process.stdout.write(JSON.stringify({
  name: name,
  private: priv,
  description: desc.slice(0, 300),
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  auto_init: false
}))
' "$REPO" "$priv" "$DESC"
}

release_json() {
  # $1 = create|update。有 release notes 文件就写正文，否则创建时让 GitHub 自动生成
  node -e '
const fs = require("node:fs")
const mode = process.argv[1]
const notesPath = process.argv[2] || ""
const tag = process.argv[3]
let body = ""
if (notesPath && fs.existsSync(notesPath)) body = fs.readFileSync(notesPath, "utf8")
const payload = {
  tag_name: tag,
  name: "dsh-purge-go " + tag.replace(/^v/, ""),
  draft: false,
  prerelease: tag.indexOf("-") !== -1
}
if (body) payload.body = body
else if (mode === "create") payload.generate_release_notes = true
else payload.body = "dsh-purge-go " + tag
process.stdout.write(JSON.stringify(payload))
' "$1" "${NOTES_FILE:-}" "$TAG"
}

# ---------------------------------------------------------------------------
# REST 封装：全部 --fail-with-body -sS，token 走 Authorization 头
# ---------------------------------------------------------------------------
api_call() {
  # $1 方法 $2 路径 $3 JSON 体（可选）；结果放 API_STATUS / API_BODY，HTTP 错误交给调用方判断
  local method="$1" path="$2" data="${3:-}"
  local url="${API_BASE}${path}" tmp err
  API_BODY=""
  API_STATUS="000"
  LAST_CURL_ERR=""

  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] curl --fail-with-body -sS -X %s %s\n' "$method" "$(redact "$url")"
    # 让计划走到「创建」分支：GET 假装 404，POST 假装 201，PATCH/DELETE 假装 200
    case "$method" in
      GET) API_STATUS="404" ;;
      POST) API_STATUS="201" ;;
      *) API_STATUS="200" ;;
    esac
    API_BODY="{}"
    return 0
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/dsh-publish-body.XXXXXX")"
  err="$(mktemp "${TMPDIR:-/tmp}/dsh-publish-err.XXXXXX")"
  if [ -n "$data" ]; then
    API_STATUS="$(curl --fail-with-body -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      --data-binary "$data" \
      -o "$tmp" -w '%{http_code}' "$url" 2>"$err")" || true
  else
    API_STATUS="$(curl --fail-with-body -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -o "$tmp" -w '%{http_code}' "$url" 2>"$err")" || true
  fi
  API_STATUS="${API_STATUS:-000}"
  API_BODY="$(cat "$tmp" 2>/dev/null || true)"
  LAST_CURL_ERR="$(cat "$err" 2>/dev/null || true)"
  rm -f "$tmp" "$err"
  return 0
}

api_message() {
  local msg
  msg="$(printf '%s' "$API_BODY" | json_get message)"
  if [ -n "$msg" ]; then
    printf '%s' "$msg"
  else
    printf '%s' "${LAST_CURL_ERR:-HTTP $API_STATUS}"
  fi
}

api_fail() {
  die "$1（HTTP $API_STATUS）：$(api_message)"
}

api_upload() {
  # 传资产到 uploads.github.com：$1 release id  $2 文件  $3 资产名
  local rid="$1" file="$2" name="$3"
  local url="${UPLOAD_BASE}/repos/${OWNER}/${REPO}/releases/${rid}/assets?name=${name}"
  local tmp err status msg

  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] curl --fail-with-body -sS -X POST %s --data-binary @%s\n' "$(redact "$url")" "$file"
    return 0
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/dsh-upload-body.XXXXXX")"
  err="$(mktemp "${TMPDIR:-/tmp}/dsh-upload-err.XXXXXX")"
  status="$(curl --fail-with-body -sS -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$file" \
    -o "$tmp" -w '%{http_code}' "$url" 2>"$err")" || true
  status="${status:-000}"
  msg="$(cat "$tmp" 2>/dev/null || true)"
  rm -f "$tmp" "$err"

  if [ "$status" != "201" ]; then
    die "上传 $(basename "$file") 失败（HTTP ${status}）：$(printf '%s' "$msg" | head -c 800)"
  fi
  note "已上传 $(basename "$file")（$(wc -c <"$file" | tr -d ' ') 字节）"
}

# ---------------------------------------------------------------------------
# 参数与环境
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --bundle) BUNDLE=1 ;;
      --org) OWNER_IS_ORG=1 ;;
      --private) VISIBILITY="private" ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "未知参数：$1（用 --help 看用法）" ;;
    esac
    shift
  done
}

resolve_version() {
  local ver=""
  if [ -n "$TAG" ]; then
    note "TAG=$TAG（来自环境变量）"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    ver="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  fi
  if [ -z "$ver" ]; then
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^" ]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"
  fi
  [ -n "$ver" ] || die "读不到 package.json 的 version，用 TAG=vX.Y.Z 显式指定"
  TAG="v$ver"
  note "TAG=$TAG（来自 package.json）"
}

resolve_desc() {
  if command -v node >/dev/null 2>&1; then
    DESC="$(node -p "require('./package.json').description || ''" 2>/dev/null || true)"
  fi
  DESC="${DESC:-dsh-purge-go: standalone prompt-inject kernel for dsh-go}"
}

resolve_notes() {
  local cand
  if [ -f "$ROOT_DIR/release-notes/$TAG.md" ]; then
    NOTES_FILE="$ROOT_DIR/release-notes/$TAG.md"
  else
    for cand in release-notes.md RELEASE_NOTES.md docs/release-notes.md; do
      if [ -f "$ROOT_DIR/$cand" ]; then
        NOTES_FILE="$ROOT_DIR/$cand"
        break
      fi
    done
  fi
  if [ -n "$NOTES_FILE" ]; then
    note "release notes：${NOTES_FILE#"$ROOT_DIR"/}"
  else
    note "release notes：无本地文件，Release 用 GitHub 自动生成的 notes"
  fi
}

token_help() {
  cat >&2 <<'EOF'
✗ 缺少 GITHUB_TOKEN（真实发布需要它；--dry-run 与 --bundle 不需要）。
  1) 打开 https://github.com/settings/tokens/new?scopes=repo&description=dsh-purge-go 勾 repo（组织仓库再勾 read:org），生成 classic token
  2) export GITHUB_TOKEN=ghp_xxx（只放环境变量，脚本不写文件、不回显）
  3) 没有 token 或手机不方便：bash scripts/publish-github.sh --bundle 走离线 bundle
EOF
  exit 1
}

resolve_owner() {
  local login=""
  if [ -n "$OWNER" ]; then
    note "owner=$OWNER（来自 GITHUB_OWNER）"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ] || [ -z "$TOKEN" ]; then
    OWNER="$OWNER_PLACEHOLDER"
    note "owner=$OWNER_PLACEHOLDER（dry-run 占位；真实发布时用 token 调 /user 取 login）"
    return 0
  fi
  api_call GET "/user"
  if [ "$API_STATUS" != "200" ]; then
    api_fail "读取当前登录名失败"
  fi
  login="$(printf '%s' "$API_BODY" | json_get login)"
  [ -n "$login" ] || die "GET /user 没返回 login，用 GITHUB_OWNER 显式指定"
  OWNER="$login"
  note "owner=$OWNER（token 对应的登录名）"
}

validate_visibility() {
  case "$VISIBILITY" in
    public | private | internal) ;;
    *) die "VISIBILITY 只能是 public / private / internal，当前：$VISIBILITY" ;;
  esac
  if [ "$OWNER_IS_ORG" = "1" ] && [ -z "${GITHUB_OWNER:-}" ]; then
    die "--org 需要同时给 GITHUB_OWNER（组织名）"
  fi
}

# ---------------------------------------------------------------------------
# git 辅助
# ---------------------------------------------------------------------------
gitq() { git -C "$ROOT_DIR" "$@"; }

ensure_repo() {
  if [ -d "$ROOT_DIR/.git" ]; then
    note "git 仓库已存在：$ROOT_DIR/.git"
    return 0
  fi
  note "初始化 git 仓库（分支 $BRANCH）"
  if ! run git -C "$ROOT_DIR" init -b "$BRANCH"; then
    run git -C "$ROOT_DIR" init
    run git -C "$ROOT_DIR" symbolic-ref HEAD "refs/heads/$BRANCH"
  fi
}

ensure_commit() {
  local dirty
  if gitq rev-parse --verify HEAD >/dev/null 2>&1; then
    dirty="$(gitq status --porcelain 2>/dev/null || true)"
    if [ -n "$dirty" ]; then
      warn "工作区有未提交改动，本次按当前文件内容提交/推送"
    fi
    return 0
  fi
  note "还没有任何提交，创建初始提交"
  run git -C "$ROOT_DIR" add -A
  run git -C "$ROOT_DIR" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
    commit -m "release: $PKG $TAG"
}

ensure_tag() {
  local head existing
  head="$(gitq rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$head" ]; then
    # dry-run 且仓库尚未初始化：只打印计划
    run git -C "$ROOT_DIR" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
      tag -a "$TAG" -m "$PKG $TAG"
    return 0
  fi
  if gitq rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    existing="$(gitq rev-parse "$TAG")"
    if [ "$existing" = "$head" ]; then
      note "本地 tag $TAG 已存在且指向 HEAD"
      return 0
    fi
    note "本地 tag $TAG 指向旧提交，移动到 HEAD"
    run git -C "$ROOT_DIR" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
      tag -f -a "$TAG" -m "$PKG $TAG"
    return 0
  fi
  note "创建 tag $TAG"
  run git -C "$ROOT_DIR" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
    tag -a "$TAG" -m "$PKG $TAG"
}

clean_repo_url() { printf 'https://github.com/%s/%s.git' "$OWNER" "$REPO"; }

token_push_url() {
  # 只用于单次 push 的参数，不写进 .git/config
  printf 'https://x-access-token:%s@github.com/%s/%s.git' "$TOKEN" "$OWNER" "$REPO"
}

remote_sha() {
  # $1 ref；dry-run 下恒为空
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  env GIT_TERMINAL_PROMPT=0 git ls-remote "$(token_push_url)" "$1" 2>/dev/null \
    | awk '{print $1}' | head -n 1
}

push_main() {
  local clean push_url sha
  clean="$(clean_repo_url)"
  push_url="$(token_push_url)"

  # origin 永远保存无 token 的 https URL
  if gitq remote get-url origin >/dev/null 2>&1; then
    run git -C "$ROOT_DIR" remote set-url origin "$clean"
  else
    run git -C "$ROOT_DIR" remote add origin "$clean"
  fi

  sha="$(remote_sha "refs/heads/$BRANCH")"
  if [ -z "$sha" ]; then
    note "远端还没有 $BRANCH，直接 push"
    run env GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" push "$push_url" "HEAD:refs/heads/$BRANCH"
  else
    note "远端 $BRANCH 已存在（$sha），先普通 push，被拒才 --force-with-lease"
    if ! run env GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" push "$push_url" "HEAD:refs/heads/$BRANCH"; then
      warn "普通 push 被拒（远端有新提交），按刚读到的基线 ${sha} 做 --force-with-lease"
      run env GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" \
        push "--force-with-lease=refs/heads/$BRANCH:$sha" "$push_url" "HEAD:refs/heads/$BRANCH"
    fi
  fi
}

push_tag() {
  local push_url sha local_sha
  push_url="$(token_push_url)"
  sha="$(remote_sha "refs/tags/$TAG")"
  if [ -z "$sha" ]; then
    note "远端没有 tag $TAG，push"
    run env GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" push "$push_url" "refs/tags/$TAG"
    return 0
  fi
  local_sha="$(gitq rev-parse "$TAG")"
  if [ "$local_sha" = "$sha" ]; then
    note "远端 tag $TAG 已一致，跳过"
    return 0
  fi
  note "远端 tag $TAG 指向旧对象，按基线 ${sha} 做 --force-with-lease"
  run env GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" \
    push "--force-with-lease=refs/tags/$TAG:$sha" "$push_url" "refs/tags/$TAG"
}

# ---------------------------------------------------------------------------
# 资产
# ---------------------------------------------------------------------------
release_assets() {
  # $1 版本号；只输出确实存在的资产，顺序固定：tgz、selfinstall、sha256sums
  local ver="$1" f
  for f in \
    "$DIST_DIR/$PKG-$ver.tgz" \
    "$DIST_DIR/$PKG-$ver-selfinstall.sh" \
    "$DIST_DIR/sha256sums.txt"; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

build_artifacts() {
  local ver="${TAG#v}" tgz selfinstall
  step "生成发布资产（dist/）"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] OUT=%s bash %s/scripts/build-selfinstall.sh\n' "$DIST_DIR" "$ROOT_DIR"
    printf '  [dry-run] 预期产物：%s %s %s\n' \
      "dist/$PKG-$ver.tgz" "dist/$PKG-$ver-selfinstall.sh" "dist/sha256sums.txt"
    return 0
  fi

  run mkdir -p "$DIST_DIR"
  if [ -f "$ROOT_DIR/scripts/build-selfinstall.sh" ]; then
    # 仓库自带：tgz + selfinstall + sha256sums 一次产出，并自检安装器
    run env OUT="$DIST_DIR" bash "$ROOT_DIR/scripts/build-selfinstall.sh"
  else
    note "没有 scripts/build-selfinstall.sh，走 npm pack 兜底"
    run npm pack --pack-destination "$DIST_DIR"
    selfinstall=""
    for f in "$ROOT_DIR"/*-selfinstall.sh; do
      if [ -f "$f" ]; then
        selfinstall="$f"
        break
      fi
    done
    if [ -n "$selfinstall" ]; then
      run cp "$selfinstall" "$DIST_DIR/$PKG-$ver-selfinstall.sh"
    else
      note "仓库根没有 *-selfinstall.sh，本次不带自解压安装器"
    fi
    (
      cd "$DIST_DIR"
      : >sha256sums.txt
      for f in ./*.tgz ./*-selfinstall.sh; do
        [ -f "$f" ] || continue
        sha256sum "$f" >>sha256sums.txt
      done
    )
  fi

  tgz="$DIST_DIR/$PKG-$ver.tgz"
  [ -f "$tgz" ] || die "缺少 $tgz"
  [ -f "$DIST_DIR/sha256sums.txt" ] || die "缺少 $DIST_DIR/sha256sums.txt"
  if [ ! -f "$DIST_DIR/$PKG-$ver-selfinstall.sh" ]; then
    warn "没有 selfinstall 资产，Release 只带 tgz + sha256sums.txt"
  fi
  note "资产清单："
  release_assets "$ver" | while read -r f; do
    printf '    %s（%s 字节）\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"
  done
}

# ---------------------------------------------------------------------------
# 通道：gh CLI
# ---------------------------------------------------------------------------
have_gh() {
  command -v gh >/dev/null 2>&1 || return 1
  gh auth status >/dev/null 2>&1 || return 1
  return 0
}

do_gh() {
  local ver="$1"
  step "通道：gh CLI（已安装且已登录）"

  if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
    note "仓库已存在：$OWNER/$REPO"
  else
    note "创建仓库 $OWNER/$REPO（$VISIBILITY）"
    run gh repo create "$OWNER/$REPO" "--$VISIBILITY" --description "$DESC"
  fi

  push_main
  push_tag

  if gh release view "$TAG" --repo "$OWNER/$REPO" >/dev/null 2>&1; then
    note "Release $TAG 已存在，更新说明与资产"
    if [ -n "$NOTES_FILE" ]; then
      run gh release edit "$TAG" --repo "$OWNER/$REPO" --title "$PKG $ver" --notes-file "$NOTES_FILE"
    else
      run gh release edit "$TAG" --repo "$OWNER/$REPO" --title "$PKG $ver" --generate-notes
    fi
  else
    note "创建 Release $TAG"
    if [ -n "$NOTES_FILE" ]; then
      run gh release create "$TAG" --repo "$OWNER/$REPO" --title "$PKG $ver" --notes-file "$NOTES_FILE"
    else
      run gh release create "$TAG" --repo "$OWNER/$REPO" --title "$PKG $ver" --generate-notes
    fi
  fi

  release_assets "$ver" | while read -r f; do
    run gh release upload "$TAG" "$f" --repo "$OWNER/$REPO" --clobber
  done
}

# ---------------------------------------------------------------------------
# 通道：curl + REST
# ---------------------------------------------------------------------------
rest_ensure_repo() {
  local payload
  step "检查/创建仓库 $OWNER/$REPO"
  api_call GET "/repos/$OWNER/$REPO"
  case "$API_STATUS" in
    200)
      note "仓库已存在，跳过创建"
      ;;
    404)
      payload="$(repo_json)"
      if [ "$OWNER_IS_ORG" = "1" ]; then
        note "在组织 $OWNER 下创建仓库"
        api_call POST "/orgs/$OWNER/repos" "$payload"
        [ "$API_STATUS" = "201" ] || api_fail "创建组织仓库失败"
      else
        note "在用户 $OWNER 下创建仓库"
        api_call POST "/user/repos" "$payload"
        [ "$API_STATUS" = "201" ] || api_fail "创建仓库失败（token 需要 repo 作用域）"
      fi
      ;;
    401)
      die "token 无效或已过期（HTTP 401）"
      ;;
    403)
      die "token 权限不足（HTTP 403）：需要 repo 作用域；组织仓库还要该组织的授权"
      ;;
    *)
      api_fail "查询仓库失败"
      ;;
  esac
}

upload_asset() {
  local file="$1" name aid
  name="$(basename "$file")"
  # 重跑要覆盖而不是 422 already_exists：先查同名资产，有就删
  api_call GET "/repos/$OWNER/$REPO/releases/$RELEASE_ID/assets"
  if [ "$API_STATUS" = "200" ]; then
    aid="$(printf '%s' "$API_BODY" | json_asset_id "$name")"
    if [ -n "$aid" ]; then
      note "同名资产已存在，先删除：$name（id $aid）"
      api_call DELETE "/repos/$OWNER/$REPO/releases/assets/$aid"
      [ "$API_STATUS" = "204" ] || warn "删除旧资产返回 HTTP $API_STATUS，继续尝试上传"
    fi
  fi
  note "上传 $name"
  api_upload "$RELEASE_ID" "$file" "$name"
}

rest_release() {
  local ver="$1" payload rid
  step "建/更新 Release $TAG"
  api_call GET "/repos/$OWNER/$REPO/releases/tags/$TAG"
  case "$API_STATUS" in
    200)
      rid="$(printf '%s' "$API_BODY" | json_get id)"
      note "Release 已存在（id ${rid}），PATCH 更新说明"
      payload="$(release_json update)"
      api_call PATCH "/repos/$OWNER/$REPO/releases/$rid" "$payload"
      [ "$API_STATUS" = "200" ] || api_fail "更新 Release 失败"
      ;;
    404)
      note "Release 不存在，创建"
      payload="$(release_json create)"
      api_call POST "/repos/$OWNER/$REPO/releases" "$payload"
      [ "$API_STATUS" = "201" ] || api_fail "创建 Release 失败"
      rid="$(printf '%s' "$API_BODY" | json_get id)"
      ;;
    *)
      api_fail "查询 Release 失败"
      ;;
  esac

  RELEASE_ID="${rid:-<release-id>}"
  release_assets "$ver" | while read -r f; do
    upload_asset "$f"
  done
}

do_rest() {
  local ver="$1"
  step "通道：curl + GitHub REST API（没有可用的 gh）"
  rest_ensure_repo
  push_main
  push_tag
  rest_release "$ver"
}

# ---------------------------------------------------------------------------
# 离线 bundle
# ---------------------------------------------------------------------------
do_bundle() {
  local ver="${TAG#v}" bundle zip
  bundle="$DIST_DIR/$PKG-$ver.bundle"
  zip="$DIST_DIR/$PKG-$ver-src.zip"

  step "离线打包（不联网、不读 token）"
  ensure_repo
  ensure_commit
  ensure_tag
  run mkdir -p "$DIST_DIR"
  note "git bundle（含全部分支与 tag，可 git clone）"
  run git -C "$ROOT_DIR" bundle create "$bundle" --all
  note "源码 zip（HEAD 快照，方便手机直接看/解压）"
  run git -C "$ROOT_DIR" archive --format=zip -o "$zip" HEAD

  if [ "$DRY_RUN" = "1" ]; then
    printf '\n==> 计划：%s / %s\n' "$bundle" "$zip"
    return 0
  fi

  [ -f "$bundle" ] || die "bundle 没生成：$bundle"
  [ -f "$zip" ] || die "zip 没生成：$zip"
  printf '\n==> 离线产物\n'
  printf '  %s（%s 字节）\n' "$bundle" "$(wc -c <"$bundle" | tr -d ' ')"
  printf '  %s（%s 字节）\n' "$zip" "$(wc -c <"$zip" | tr -d ' ')"
  cat <<EOF

  手机 / 无 token 机器上导入：
    1) 把 $(basename "$bundle") 传过去，然后
         git clone $(basename "$bundle") dsh-purge-go
       得到完整历史与标签，再在那边配好 token 跑一次本脚本即可 push。
    2) 只要源码就解压 $(basename "$zip")，或直接 npm pack 安装。
    3) 安装器：把 dist/$PKG-$ver-selfinstall.sh 传到手机执行即可（不需要 git）。
EOF
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
finish() {
  local repo_url
  repo_url="https://github.com/$OWNER/$REPO"
  printf '\n==> 完成\n'
  printf '  仓库：%s\n' "$repo_url"
  printf '  Release：%s/releases/tag/%s\n' "$repo_url" "$TAG"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  （dry-run：以上只是计划，未联网、未改任何文件）\n'
  fi
  if ! command -v gh >/dev/null 2>&1; then
    printf '  提示：本机没有 gh，走的是纯 curl REST 通道；装了 gh 并 gh auth login 后会自动优先用 gh。\n'
  fi
}

main() {
  parse_args "$@"
  cd "$ROOT_DIR"

  step "环境"
  printf '  仓库目录：%s\n' "$ROOT_DIR"
  if [ "$BUNDLE" = "1" ]; then
    printf '  模式：离线 bundle（只产归档，不联网）\n'
  else
    printf '  模式：%s\n' "$([ "$DRY_RUN" = "1" ] && printf 'dry-run（只打印计划）' || printf '真实发布')"
  fi
  if [ "$BUNDLE" = "1" ]; then
    printf '  子模式：--bundle（离线，不联网）\n'
  fi

  validate_visibility
  resolve_version
  resolve_desc
  resolve_notes

  if [ "$BUNDLE" = "1" ]; then
    # 离线：不需要 token / owner，直接产 bundle + zip
    [ -n "$OWNER" ] || OWNER="$OWNER_PLACEHOLDER"
    do_bundle
    finish
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    TOKEN="${TOKEN:-$TOKEN_PLACEHOLDER}"
  elif [ -z "$TOKEN" ]; then
    token_help
  fi

  resolve_owner
  [ -n "$OWNER" ] || die "OWNER 为空，用 GITHUB_OWNER 显式指定"

  if have_gh; then
    ensure_repo
    ensure_commit
    ensure_tag
    do_gh "${TAG#v}"
  else
    if [ "$DRY_RUN" = "0" ]; then
      note "本机没有可用的 gh（未安装或未登录），走 curl REST 通道"
    else
      note "本机没有可用的 gh，dry-run 按 curl REST 通道打印计划"
    fi
    ensure_repo
    ensure_commit
    ensure_tag
    do_rest "${TAG#v}"
  fi

  finish
}

main "$@"
