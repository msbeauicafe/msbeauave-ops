// The landing page's only live part: real photographs and real brand counts,
// read off the same open catalogue the shop window uses. If it cannot be
// reached the page still reads whole — the wall stays a plain gradient and
// the brand list says so.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const photo = (sku) => `/api/products/${encodeURIComponent(sku)}/photo`;

(async () => {
  const brandsBox = document.getElementById('brands');
  try {
    const res = await fetch('/api/shop/catalog', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error();
    const goods = await res.json();

    // Brands by how deep we carry them — the houses somebody is most likely
    // to have come for, first.
    const count = new Map();
    for (const p of goods) {
      const b = (p.brand || '').trim();
      if (b) count.set(b, (count.get(b) || 0) + 1);
    }
    const brands = [...count].sort((a, b) => b[1] - a[1]);
    brandsBox.innerHTML = brands.slice(0, 24)
      .map(([b, n]) => `<span>${esc(b)} <i>${n}</i></span>`).join('')
      + (brands.length > 24 ? `<span class="more">+${brands.length - 24} more</span>` : '');

    document.getElementById('stats').textContent =
      `${goods.length.toLocaleString('en-PH')} products · ${brands.length} brands · one showroom in Marikina`;

    // Photographed products only, on the shelf first, one per brand so the
    // wall shows the range rather than twelve of the same tub.
    const seen = new Set();
    const pics = goods.filter((p) => p.has_photo)
      .sort((a, b) => Number(b.in_stock) - Number(a.in_stock))
      .filter((p) => !seen.has(p.brand) && seen.add(p.brand))
      .slice(0, 9);
    document.getElementById('wall').innerHTML = pics
      .map((p) => `<img src="${photo(p.sku)}" alt="" loading="lazy">`).join('');
  } catch {
    brandsBox.innerHTML = '<span class="dim">See the full list in our shop.</span>';
  }
})();
