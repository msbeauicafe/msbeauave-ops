// Claiming a wholesale account. The link is single use and dies on a date;
// this page checks it before showing a form, so somebody following a dead one
// is told so rather than filling it in for nothing.
//
// The eye matters more here than anywhere: this is where a password is chosen,
// and it has to be typed twice.
import '../reveal.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const token = new URLSearchParams(location.search).get('t') || '';
const panel = $('#panel');

const dead = (why) => {
  panel.innerHTML = `<h2>That link cannot be used</h2>
    <p class="lede">${esc(why)}</p>
    <p class="hint">Links last two weeks and work once. Ask us and we will send
      another.</p>`;
};

function form(business, expires) {
  panel.innerHTML = `
    <h2>Welcome, ${esc(business)}</h2>
    <p class="lede">Choose how you will sign in. Nobody here sees your password
      — if you lose it we issue a new link rather than reading it back.</p>
    <form id="claim" novalidate>
      <label for="u">Username</label>
      <input id="u" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <p class="hint">At least three characters. This is what you type to sign in.</p>

      <label for="p">Password</label>
      <input id="p" type="password" autocomplete="new-password" required>
      <p class="hint">At least eight characters.</p>

      <label for="p2">Password again</label>
      <input id="p2" type="password" autocomplete="new-password" required>

      <button class="btn" id="go">Create my account</button>
      <p class="err" id="err" hidden></p>
      <p class="hint">This link stops working once you have used it${
        expires ? `, and expires on ${esc(new Date(expires).toLocaleDateString('en-PH',
          { dateStyle: 'medium', timeZone: 'Asia/Manila' }))}` : ''}.</p>
    </form>`;

  $('#claim').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err');
    err.hidden = true;
    // Checked here as well as at the far end. Being told a password does not
    // match after a round trip, with both boxes cleared, is a small cruelty.
    if ($('#p').value !== $('#p2').value) {
      err.textContent = 'The two passwords are not the same.';
      err.hidden = false;
      return;
    }
    $('#go').disabled = true;
    try {
      const res = await fetch('/api/reseller/invite/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, username: $('#u').value, password: $('#p').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That could not be completed.');
      panel.innerHTML = `<div class="done"><div class="tick">🌸</div>
        <h2>Your account is ready</h2>
        <p>Sign in with the username you just chose.</p>
        <p style="margin-top:16px"><a class="btn" href="/portal/"
          style="display:inline-block;width:auto;padding:12px 26px;text-decoration:none">
          Open the reseller portal</a></p></div>`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      $('#go').disabled = false;
    }
  });
}

if (!token) {
  dead('This address is missing its code.');
} else {
  try {
    const res = await fetch(`/api/reseller/invite?t=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) dead(data.error || 'That link is not valid any more.');
    else form(data.business, data.expires_at);
  } catch {
    dead('We could not reach the website. Check your connection and try again.');
  }
}
