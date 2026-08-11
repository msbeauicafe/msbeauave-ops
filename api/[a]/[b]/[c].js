// The whole API, as one serverless function — reachable at every path depth
// the router uses.
//
// A single [...route].js catch-all is the obvious way to write this, and it is
// what this file replaced: on this project Vercel only ever routed one segment
// to it, so /api/till/products never reached the application at all. One file
// per depth is more typing and no cleverness, but it is routing the platform
// cannot decline to do. The deepest route is /api/portal/orders/:id/cancel.
//
// Every one of these delegates to the same router, which reads the real path
// off the request — the [a]/[b] names are placeholders that nothing looks at.
import '../../../lib/routes.js';
import { handle } from '../../../lib/router.js';

export default handle;
