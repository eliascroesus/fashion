#!/bin/sh
# After look-page.yaml: Home before opening a look and after Back must look the same
# (status bar and scroll indicator left out). The crop is sized for the iPhone 18 Pro
# simulator (1206 × 2622 screenshots) and uses macOS tools (sips, md5). Usage:
#   apps/mobile/.maestro/same-place.sh <maestro test output folder> [before after]
# (screenshot names; home-before and home-after unless given, e.g. for save-keeps-place.yaml).
set -eu
first=${2:-home-before}
second=${3:-home-after}
dir=$(dirname "$(find "$1" -name "$first.png" | head -1)")
# Status bar and the right edge (the scroll indicator fades out after scrolling) left out.
crop() { sips -c 2200 1150 --cropOffset 220 0 "$dir/$1.png" --out "$dir/$1-crop.png" >/dev/null; md5 -q "$dir/$1-crop.png"; }
before=$(crop "$first")
after=$(crop "$second")
if [ "$before" = "$after" ]; then echo "Same place: Home is pixel-identical ($first, $second)."; else echo "Moved: Home differs ($first, $second)."; exit 1; fi
