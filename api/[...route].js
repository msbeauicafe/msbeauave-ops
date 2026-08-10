// The whole API, as one serverless function.
//
// Static files are served straight from the CDN out of public/, so this
// function never touches the filesystem and needs nothing bundled with it.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   DATABASE_URL    Postgres connection string (Supabase → transaction pooler)
//   SESSION_SECRET  any long random string; without it, every deployment
//                   signs everyone out
import '../lib/routes.js';
import { handle } from '../lib/router.js';

export default handle;
