#!/bin/sh

set -eu

usage() {
  echo "Usage: $0 <instance-name> [official|customize]" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

instance_name=$1
profile=${2:-}

case "$instance_name" in
  [A-Za-z0-9]*)
    case "$instance_name" in
      *[!A-Za-z0-9_-]*)
        echo "Instance name may contain only letters, numbers, underscores, and hyphens." >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "Instance name must start with a letter or number." >&2
    exit 2
    ;;
esac

if [ -z "$profile" ]; then
  if [ ! -t 0 ]; then
    echo "Choose a workflow profile by passing official or customize." >&2
    usage
    exit 2
  fi

  echo "Choose a workflow profile:"
  echo "  1) official — use the upstream Symphony workflow unchanged"
  echo "  2) customize — apply the local Japanese/Linear/PR workflow overlay"
  printf "Profile [1]: "
  read -r choice

  case "${choice:-1}" in
    1 | official) profile=official ;;
    2 | customize) profile=customize ;;
    *)
      echo "Unknown workflow profile: $choice" >&2
      exit 2
      ;;
  esac
fi

case "$profile" in
  official | customize) ;;
  *)
    echo "Unknown workflow profile: $profile" >&2
    usage
    exit 2
    ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="$repo_root/symphonies/$instance_name"
overlay="$repo_root/overlays/customize/workflow.patch"

if [ -e "$target" ]; then
  echo "Instance already exists: $target" >&2
  exit 1
fi

if [ "$profile" = "customize" ]; then
  git -C "$repo_root" apply \
    --check \
    --directory=symphony_template \
    "$overlay"
fi

cp -R "$repo_root/symphony_template" "$target"

if [ "$profile" = "customize" ]; then
  git -C "$repo_root" apply \
    --directory="symphonies/$instance_name" \
    "$overlay"
fi

echo "Created Symphony instance '$instance_name' with the '$profile' workflow profile."
echo "Next, configure: symphonies/$instance_name/elixir/WORKFLOW.md"
