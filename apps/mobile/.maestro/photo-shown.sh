#!/bin/sh
# After look-page.yaml: the opened look's photo is really drawn, not just its main colour as a
# flat frame (the bug the plain stand-in pictures hid until real photos came in). The crop is
# sized for the iPhone 18 Pro simulator (1206 × 2622 screenshots); macOS tools only (sips, python3).
# Usage: apps/mobile/.maestro/photo-shown.sh <maestro test output folder>
set -eu
shot=$(find "$1" -name look-open.png | head -1)
tmp=$(mktemp -d)
# The middle of the photo (clear of the round buttons), shrunk to 16 × 16.
sips -c 1000 600 --cropOffset 600 300 "$shot" --out "$tmp/middle.png" >/dev/null
sips -z 16 16 -s format bmp "$tmp/middle.png" --out "$tmp/middle.bmp" >/dev/null
python3 - "$tmp/middle.bmp" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
offset = struct.unpack_from('<I', data, 10)[0]
width, height = struct.unpack_from('<ii', data, 18)
step = struct.unpack_from('<H', data, 28)[0] // 8
row = (width * step + 3) & ~3
brightness = []
for y in range(abs(height)):
    for x in range(width):
        b, g, r = data[offset + y * row + x * step : offset + y * row + x * step + 3]
        brightness.append(0.299 * r + 0.587 * g + 0.114 * b)
spread = max(brightness) - min(brightness)
if spread < 30:
    sys.exit(f'Photo not drawn: the look page shows one flat colour (brightness spread {spread:.0f}).')
print(f'Photo drawn (brightness spread {spread:.0f}).')
PY
