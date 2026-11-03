#!/bin/sh
# After look-page.yaml: Home before opening a look and after Back must look the same
# (status bar and scroll indicator left out). The crop is sized for the iPhone 18 Pro
# simulator (1206 × 2622 screenshots) and uses macOS tools (sips, md5). Usage: apps/mobile/.maestro/same-place.sh <maestro test output folder>
set -eu
dir=$(dirname "$(find "$1" -name home-before.png | head -1)")
# Status bar and the right edge (the scroll indicator fades out after scrolling) left out.
crop() { sips -c 2200 1150 --cropOffset 220 0 "$dir/$1.png" --out "$dir/$1-crop.png" >/dev/null; md5 -q "$dir/$1-crop.png"; }
before=$(crop home-before)
after=$(crop home-after)
if [ "$before" = "$after" ]; then echo "Same place: Home is pixel-identical after Back."; else echo "Moved: Home differs after Back."; exit 1; fi
