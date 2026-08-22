#!/usr/bin/env bash
# Build the BOA Staff app.
#
# Everything is ready except the artwork: drop the Beauty Obsession Avenue logo
# in as public/boa.jpg and run this. It cuts the launcher icons from that
# one file, builds the flavour that already exists in the gradle project, and
# leaves the APK where the download page expects it.
#
# The logo is the only thing that cannot be written from here — it is a real
# company's mark, and an approximation of it would be worse than none.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID="${ANDROID_PROJECT:-/home/user/Ms-Beau-Ave/android}"
LOGO="${BOA_LOGO:-$ROOT/public/boa.jpg}"
KEY="${BOA_KEYSTORE:-$ANDROID/app/boa-staff.jks}"
PASS="${BOA_KEYSTORE_PASSWORD:-msbeauave}"

[ -f "$LOGO" ] || { echo "Put the BOA logo at $LOGO first."; exit 1; }

echo "==> cutting launcher icons from the logo"
python3 - "$LOGO" "$ANDROID/app/src/boastaff/res" <<'PYEOF'
import sys, os
from PIL import Image

logo, res = sys.argv[1], sys.argv[2]
im = Image.open(logo).convert('RGBA')

# Trim the flat border the artwork sits on, so the mark fills the icon rather
# than swimming in it. Measured from the corner pixel rather than assumed.
bg = im.getpixel((0, 0))
mask = Image.new('L', im.size, 0)
px, mk = im.load(), mask.load()
for y in range(im.height):
    for x in range(im.width):
        r, g, b, a = px[x, y]
        if a and (abs(r-bg[0]) > 12 or abs(g-bg[1]) > 12 or abs(b-bg[2]) > 12):
            mk[x, y] = 255
box = mask.getbbox() or (0, 0, im.width, im.height)
im = im.crop(box)

# The wordmark is wide and would be illegible squeezed into 48dp square, so it
# is padded onto the brand's own pale blue rather than cropped.
PAD = (217, 238, 251, 255)
for name, size in [('mdpi',48), ('hdpi',72), ('xhdpi',96), ('xxhdpi',144), ('xxxhdpi',192)]:
    inner = int(size * 0.88)
    w, h = im.size
    scale = min(inner / w, inner / h)
    art = im.resize((max(1,int(w*scale)), max(1,int(h*scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), PAD)
    canvas.paste(art, ((size-art.width)//2, (size-art.height)//2), art)
    out = os.path.join(res, 'mipmap-' + name)
    os.makedirs(out, exist_ok=True)
    canvas.save(os.path.join(out, 'ic_launcher.png'))
    print('  icon', name, size)

w, h = im.size
scale = min(512 / w, 512 / h)
art = im.resize((int(w*scale), int(h*scale)), Image.LANCZOS)
splash = Image.new('RGBA', (640, 640), PAD)
splash.paste(art, ((640-art.width)//2, (640-art.height)//2), art)
os.makedirs(os.path.join(res, 'drawable'), exist_ok=True)
splash.save(os.path.join(res, 'drawable', 'splash.png'))
print('  splash 640x640')
PYEOF

[ -f "$KEY" ] || {
  echo "==> making a signing key"
  keytool -genkeypair -keystore "$KEY" -storepass "$PASS" -keypass "$PASS" \
    -alias boastaff -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Beauty Obsession Avenue, O=Beauty Obsession Avenue Corp, L=Manila, C=PH"
}

echo "==> building"
cd "$ANDROID"
gradle --offline -q :app:assembleBoastaffRelease \
  -PstoreFile="$(basename "$KEY")" -PstorePassword="$PASS" \
  -PkeyAlias=boastaff -PkeyPassword="$PASS" -Pvcode=1 -Pvname=1.0

cp app/build/outputs/apk/boastaff/release/app-boastaff-release.apk \
   "$ROOT/public/get/boa-staff.apk"

echo "==> the fingerprint for assetlinks.json"
"$(ls -d /opt/android-sdk/build-tools/*/ | tail -1)apksigner" verify \
  --print-certs "$ROOT/public/get/boa-staff.apk" | grep 'SHA-256'
echo "==> done: public/get/boa-staff.apk"
