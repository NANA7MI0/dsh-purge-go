#!/bin/sh
# 打印本包会注入的提示词正文（明文）。
#
# 仓库里存的是加密后的 lib/asset-table.json，密钥材料与密文同仓（lib/table-key.js 的 MIX
# 盐 + asset-table.json 里的 MASK/TAG/IV），所以这条命令不是解锁什么权限，只是把
# 那段正文原样打出来给人看。装完之后同样的内容也会落在 ~/.dsh/prompt-inject.md。
cd "$(dirname "$0")/.." || exit 1
node --input-type=module -e "import('./lib/table-read.js').then(m => { const t = m.openSlot(); if (!t) { console.error('解不开 lib/asset-table.json'); process.exit(1) } process.stdout.write(t + '\\n') })"