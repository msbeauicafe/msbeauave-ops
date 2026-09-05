# Working on MS Beau Ave

Notes for whoever picks this up next — me, in a session that remembers none of
this.

## How the owner works

Small changes, shipped one at a time. Fix, run the tests, merge, wait out the
Vercel rebuild, *then* say "refresh". Never say refresh before the deploy is
actually live — `curl` the deployed `app.js` and grep for a marker first. The
owner watches `127.0.0.1:9500`, which lags the deploy by a build or two, so a
hard refresh alone will not show a change: only a finished rebuild will.

Suggest, don't ask. A short suggestion the owner can answer with one word beats
a question box.

## Lessons paid for

- **A list and the form behind it are one change.** Rename or reorder a table's
  columns and the form that fills them has to be opened in the same pass. The
  owner should not be the one who notices the form still says "Costs us" when
  the column says "Cost price".
- **Build a feature everywhere it is used, not only where it was asked.** A
  thing added to the edit form is wanted on the new-record form too.
- **Fields the shop picks from, it should not be able to type into.** Free text
  is how `aaaaa` ends up in a dropdown.

## The shape of things

- `public/app.js` is the whole front end: `SCREENS`, `dialog`, `table`, `tag`,
  `GET/POST/PUT/DELETE`.
- `lib/routes.js` is the whole back end: `on(method, pattern, roles, handler)`.
- `db/NNN_*.sql` are migrations, applied in order. A `security definer`
  function **must** pin `search_path` — `tests/search-path.test.js` enforces it.
- `npm test` runs everything. It should be 126 green before anything merges.
