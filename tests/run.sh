#!/usr/bin/env bash
# Runs every *.test.js and reports the totals. Node is the only requirement and
# it is a development-time one — nothing here ships in the .plasmoid.
set -uo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "node is required to run the tests (development only; not a runtime dependency)" >&2
    exit 127
fi

total=0
failed=0
for f in *.test.js; do
    out=$(node "$f" 2>&1)
    status=$?
    line=$(printf '%s\n' "$out" | grep -E '^[0-9]+ passed' | tail -1)
    n=$(printf '%s' "$line" | grep -oE '^[0-9]+' || echo 0)
    total=$((total + n))
    if [ $status -ne 0 ]; then
        failed=$((failed + 1))
        printf '%-26s FAIL\n' "$f"
        printf '%s\n' "$out" | grep -E '^\s+FAIL' | head -20
    else
        printf '%-26s %s\n' "$f" "${line:-ok}"
    fi
done

echo "-----"
if [ $failed -ne 0 ]; then
    echo "$failed suite(s) failed"
    exit 1
fi
echo "$total assertions passed"
