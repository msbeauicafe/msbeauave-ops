// Cut a wordmark out of the artwork it was sent in.
//
// A logo arrives as a square picture with the mark floating in the middle of a
// wide flat margin. Set on a page at the height a round badge occupies, what
// you see is mostly that margin and a name too small to read — which is the
// one thing a name on a wall has to do.
//
// So the flat ground is measured off the corner pixel and cropped away, and
// what is left is the mark at its own aspect ratio. The source is kept as it
// was sent; this writes a second file beside it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: trim-mark.mjs <source image> <output png>');
  process.exit(1);
}

execFileSync('python3', ['-c', `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
bg = im.getpixel((0, 0))

# The ground is not one flat colour — it is a gentle gradient — so a pixel
# counts as ground if it is close to the colour directly across from it on the
# same row of the margin, rather than close to one sampled corner.
w, h = im.size
mask = Image.new('L', im.size, 0)
px, mk = im.load(), mask.load()
for y in range(h):
    edge = px[0, y]
    for x in range(w):
        r, g, b, a = px[x, y]
        if a and (abs(r-edge[0]) > 18 or abs(g-edge[1]) > 18 or abs(b-edge[2]) > 18):
            mk[x, y] = 255
box = mask.getbbox()
if not box:
    print('nothing to trim'); im.save(out); sys.exit()

# A hair of room so the outline is not shaved off.
pad = max(2, min(im.size) // 120)
box = (max(0, box[0]-pad), max(0, box[1]-pad),
       min(w, box[2]+pad), min(h, box[3]+pad))
mark = im.crop(box)
mark.save(out)
print(f'{im.size[0]}x{im.size[1]} -> {mark.size[0]}x{mark.size[1]}')
`, src, out], { stdio: 'inherit' });
