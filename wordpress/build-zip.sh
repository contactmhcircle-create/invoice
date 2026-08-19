#!/usr/bin/env sh
# Build an installable WordPress plugin ZIP from the ai-file-tools folder.
set -e
cd "$(dirname "$0")"
rm -f ai-file-tools.zip
zip -r ai-file-tools.zip ai-file-tools -x '*.DS_Store'
echo "Created $(pwd)/ai-file-tools.zip — upload it via Plugins → Add New → Upload Plugin."
