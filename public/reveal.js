// An eye on every password box.
//
// A phone keyboard shows nothing back. Somebody typing a password that was
// handed to them on paper cannot tell a wrong character from a right one until
// the sign-in refuses them — and then they type the same wrong thing again.
//
// This decorates whatever is on the page now and keeps watching, because the
// back office replaces whole screens with innerHTML: the sign-in form, the new
// sign-in row and the change-password dialog are three different moments and
// none of them would remember to call this. Importing the file is the whole
// contract, which is what stops the next password box being added without one.
//
// Nothing is stored and nothing leaves the page — it flips the input's type and
// flips it back. A box that is showing goes back to hidden when the screen
// moves on, because the element itself is gone.

const STYLE = `
.pw-reveal { position: relative; display: block; }
.pw-reveal > input { padding-right: 2.7em; }
.pw-reveal > .pw-eye {
  position: absolute; top: 0; right: 0; height: 100%; width: 2.7em;
  display: flex; align-items: center; justify-content: center;
  border: 0; background: none; padding: 0; margin: 0; cursor: pointer;
  color: inherit; opacity: .5;
}
.pw-reveal > .pw-eye:hover, .pw-reveal > .pw-eye:focus-visible { opacity: 1; }
.pw-reveal > .pw-eye svg { width: 20px; height: 20px; display: block; }
`;

// Drawn rather than typed. An emoji eye is a different size, a different
// colour and sometimes a missing glyph depending on which font the tablet,
// the phone and the shop PC happen to have.
const OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M1.8 12S5.5 5 12 5s10.2 7 10.2 7-3.7 7-10.2 7S1.8 12 1.8 12Z"/>
  <circle cx="12" cy="12" r="3"/></svg>`;

const SHUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M1.8 12S5.5 5 12 5s10.2 7 10.2 7-3.7 7-10.2 7S1.8 12 1.8 12Z"/>
  <circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>`;

function styleOnce() {
  if (document.getElementById('pw-reveal-style')) return;
  const el = document.createElement('style');
  el.id = 'pw-reveal-style';
  el.textContent = STYLE;
  document.head.append(el);
}

function decorate(input) {
  if (!input.parentNode || input.closest('.pw-reveal')) return;

  // Moving an element blurs it, and the change-password box is opened with the
  // cursor already in it. Put the cursor back where it was.
  const had = document.activeElement === input;

  const wrap = document.createElement('span');
  wrap.className = 'pw-reveal';
  input.replaceWith(wrap);
  wrap.append(input);

  const eye = document.createElement('button');
  eye.type = 'button';                    // inside a form, a button submits it
  eye.className = 'pw-eye';
  eye.innerHTML = OPEN;
  eye.title = 'Show password';
  eye.setAttribute('aria-label', 'Show password');
  wrap.append(eye);

  eye.addEventListener('click', () => {
    const showing = input.type === 'text';
    // Some browsers drop the caret to the end when the type changes; a person
    // correcting the middle of a password would lose their place.
    const at = [input.selectionStart, input.selectionEnd];
    input.type = showing ? 'password' : 'text';
    eye.innerHTML = showing ? OPEN : SHUT;
    eye.title = showing ? 'Show password' : 'Hide password';
    eye.setAttribute('aria-label', eye.title);
    input.focus();
    try { input.setSelectionRange(at[0], at[1]); } catch { /* not all types allow it */ }
  });

  if (had) input.focus();
}

// Every password box on the page, wherever it came from. Deliberately not a
// list of the seven that exist today: the eighth is the one that would be
// forgotten.
const scan = () => document.querySelectorAll('input[type=password]').forEach(decorate);

function start() {
  styleOnce();
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
