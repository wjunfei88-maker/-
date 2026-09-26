#!/bin/bash
# 双击运行：自动找到 inbox 里最新的导出文件并做像素级比对
cd "$(dirname "$0")" || exit 1
clear
echo "════════════════════════════════════════════════════════════"
echo "   像素蛋糕导出结果 · 自动比对"
echo "════════════════════════════════════════════════════════════"
echo
echo "正在检查 inbox/roundtrip 和 inbox/edited ..."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没有找到 node，请先安装 Node.js"
  echo; echo "按回车键关闭…"; read -r; exit 1
fi

node tools/m0-compare.mjs "$@"
code=$?

echo
echo "════════════════════════════════════════════════════════════"
if [ $code -eq 0 ]; then
  echo "  ✅ 比对完成（结果见上方，也存到了 probes/*.report.json）"
elif [ $code -eq 1 ]; then
  echo "  ⚠️  inbox 里没有找到图片 —— 请先把像素蛋糕导出的文件放进"
  echo "     pixcake-tiler/inbox/roundtrip/"
elif [ $code -eq 2 ]; then
  echo "  ❌ 尺寸不一致 —— 这是关键发现，请把上面的输出整段发给我"
else
  echo "  ❌ 运行出错（退出码 $code），请把上面的输出整段发给我"
fi
echo "════════════════════════════════════════════════════════════"
echo
echo "按回车键关闭窗口…"
read -r
