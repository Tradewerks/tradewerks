#!/bin/bash
# Apply one design system to the running app. Revert with: git checkout -- frontend/src
set -euo pipefail
SYS="$1"
REPO=/home/steph/Desktop/EpicIT-Dispatch/EpicIT-Dispatch
SP="$(cd "$(dirname "$0")" && pwd)"

case "$SYS" in
  01) IMPORT='@import url("https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap");'
      STACK="'Archivo', system-ui, sans-serif" ;;
  02) IMPORT='@import url("https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap");'
      STACK="'Instrument Sans', system-ui, sans-serif" ;;
  03) IMPORT='@import url("https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Public+Sans:wght@400;500;600;700&display=swap");'
      STACK="'Public Sans', system-ui, sans-serif" ;;
  *) echo "unknown system $SYS"; exit 1 ;;
esac

THEME=$(echo "$SP/${SYS}-"*/theme.css)
cp "$THEME" "$REPO/frontend/src/styles/theme.css"

# Swap the font import (line 1) and the global font-family in index.css
python3 - "$REPO/frontend/src/index.css" "$IMPORT" "$STACK" <<'PY'
import sys, re
path, imp, stack = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
s = re.sub(r'^@import url\("https://fonts\.googleapis\.com[^\n]*\n', imp + "\n", s, count=1, flags=re.M)
s = s.replace('font-family: "Inter";', f'font-family: {stack};', 1)
open(path, "w").write(s)
PY

echo "applied system $SYS"
head -1 "$REPO/frontend/src/index.css"
grep -n "font-family:" "$REPO/frontend/src/index.css" | head -3
