// Applying for a wholesale account. Public, and deliberately thin: it can add
// one row and read nothing at all.
const $ = (s) => document.querySelector(s);

$('#apply').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#go');
  const err = $('#err');
  err.hidden = true;
  go.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(e.target));
    const res = await fetch('/api/reseller/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That could not be sent.');
    $('#form').hidden = true;
    $('#done').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    go.disabled = false;
  }
});
