#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

git subtree pull \
  --prefix=symphony_template \
  https://github.com/openai/symphony.git \
  main \
  --squash
