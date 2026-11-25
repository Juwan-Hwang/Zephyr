#!/bin/bash
# Upload screenshots to uguu.se (temporary, about 3 hours) so the hosted browser can view them.
# usage: DIR=... OUT=... upload.sh files...
cd "${DIR:-${WORK:-.}/proto-tools/out}"
out=${OUT:-${WORK:-.}/proto-tools/urls.txt}
: > "$out"
for f in "$@"; do
  u=$(curl -s -m 120 -F "files[]=@$f" https://uguu.se/upload | python3 -c 'import sys,json;print(json.load(sys.stdin)["files"][0]["url"])' 2>/dev/null)
  echo "$f $u" | tee -a "$out"
done
