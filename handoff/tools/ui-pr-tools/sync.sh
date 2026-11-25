#!/bin/bash
# Refresh the screenshot site from the PR worktree, keeping the mock layer.
set -e
cd ${WORK:-.}/wt-ui-pr/apps/desktop && pnpm run build:css >/dev/null 2>&1
rsync -a --delete --exclude proto ${WORK:-.}/wt-ui-pr/apps/desktop/src/ ${SITE:-${WORK:-.}/ui-pr-tools/site}/
cd ${SITE:-${WORK:-.}/ui-pr-tools/site}
sed -i 's|    <script type="module" src="main.js" defer></script>|    <link rel="stylesheet" href="proto/pf-override.css" />\n    <script src="proto/bootstrap.js"></script>\n    <script type="module" src="proto/boot.js"></script>\n    <script type="module" src="main.js" defer></script>|' index.html
grep -c 'proto/boot.js' index.html
