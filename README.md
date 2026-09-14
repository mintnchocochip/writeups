# Writeups

CTF and security writeups, published as a static site.

Live at **https://mintnchocochip.github.io/writeups/**

## Publishing a writeup

1. In Notion: **••• → Export → Markdown & CSV**, unzip it.
2. Import it:

   ```bash
   npm run import -- "path/to/Export-abc123"
   ```

3. Check it locally with `npm run dev`, then:

   ```bash
   git add -A && git commit -m "writeup: <name>" && git push
   ```

Pushing to `main` runs the tests, builds, and deploys. That's the whole loop.

## What the importer does

Notion's export is not directly usable: filenames carry a 32-char page id, there's
no frontmatter, the title lives in an `# H1`, and image paths are URL-encoded.
`scripts/import-notion.mjs` turns each page into `src/content/writeups/<slug>.md`
with proper frontmatter, and copies its images to `src/content/writeups/<slug>/`
so Astro can optimize them.

It **skips files that already exist** — pass `--force` to overwrite. This is
deliberate: re-importing an export should not destroy frontmatter you hand-edited.

Known gap: links from one exported page to another are left as-is and reported as a
warning. Fix those by hand; there usually aren't any.

## Layout

| Path | What |
|---|---|
| `src/content/writeups/` | The posts. One `.md` per writeup, plus a folder of its images. |
| `src/content.config.ts` | Frontmatter schema (`title`, `pubDate`, `tags`, optional `description`). |
| `src/pages/index.astro` | The writeup list. |
| `src/pages/[...slug].astro` | A single writeup. |
| `scripts/import-notion.mjs` | The Notion importer. |

## Commands

```bash
npm run dev      # local server at localhost:4321/writeups/
npm run build    # production build into dist/ — schema errors surface here
npm test         # importer tests
```

## Notes

`astro.config.mjs` sets `base: '/writeups'` because the site is served from a
subpath. Internal links must go through the `url()` helper in `src/consts.ts` — a
bare `href="/foo"` works in `dev` and 404s in production.

Dates are stored date-only and rendered in UTC, so a writeup dated September 2 does
not show as September 1 when built on a runner in a different timezone.
