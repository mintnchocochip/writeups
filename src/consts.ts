// Global site data, imported anywhere via `import { SITE_TITLE } from '../consts'`.

export const SITE_TITLE = 'Writeups';
export const SITE_DESCRIPTION = 'CTF and security writeups.';

// Prefix an internal path with the deployed base path.
// Needed because the site is served from /writeups, not the domain root:
// a bare href="/about" works in `astro dev` and 404s in production.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const url = (path: string) => BASE + path;
