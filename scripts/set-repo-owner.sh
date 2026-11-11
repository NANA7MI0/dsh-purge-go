#!/usr/bin/env bash
# 把仓库里的 OWNER 占位符换成一个真实的 GitHub 用户名/组织名。
#
#   bash scripts/set-repo-owner.sh <owner>            # 替换并打印改了哪些文件
#   bash scripts/set-repo-owner.sh <owner> --dry-run  # 只看会改什么
#
# 覆盖：README.md、docs/COMPATIBILITY.md、CHANGELOG.md、package.json、NOTICE。
# 不动 .github/workflows/*（里面没有 OWNER 占位符，仓库归属由 GitHub 自己决定）。
set -euo pipefail

cd "$(dirname "$0")/.."
OWNER="${1:-}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

if [ -z "$OWNER" ]; then
  echo "用法: bash scripts/set-repo-owner.sh <github-owner> [--dry-run]" >&2
  exit 2
fi
case "$OWNER" in
  *[!A-Za-z0-9-]*|'') echo "✗ owner 只能包含字母、数字、连字符: $OWNER" >&2; exit 2 ;;
esac

FILES="README.md docs/COMPATIBILITY.md CHANGELOG.md package.json NOTICE"
changed=0
for f in $FILES; do
  [ -f "$f" ] || continue
  n=$(grep -c 'OWNER' "$f" 2>/dev/null || true)
  [ "${n:-0}" -gt 0 ] || continue
  if [ "$DRY" = 1 ]; then
    printf '  [dry-run] %-28s %s 处\n' "$f" "$n"
  else
    # OWNER 只以占位符形式出现（OWNER/dsh-purge-go、github.com/OWNER/），直接全量替换是安全的
    tmp="$f.tmp.$$"
    sed "s/OWNER/$OWNER/g" "$f" > "$tmp" && mv "$tmp" "$f"
    printf '  ✓ %-28s 替换 %s 处\n' "$f" "$n"
  fi
  changed=$((changed + 1))
done

if [ "$changed" -eq 0 ]; then
  echo "· 没有找到 OWNER 占位符（可能已经替换过）"
else
  echo "· 共 $changed 个文件$([ "$DRY" = 1 ] && echo '（dry-run，未写入）')"
  [ "$DRY" = 1 ] || echo "· 下一步: bash scripts/publish-github.sh --dry-run 复核，再 bash scripts/publish-github.sh 发布"
fi
