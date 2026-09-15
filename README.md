# Writeups

CTF and security writeups, published as a static site.

Live at **https://mintnchocochip.github.io/writeups/**

## Publishing a writeup

1. Export the markdown. Notion: **••• → Export → Markdown & CSV**, unzip.
   GitBook: clone the repo.
2. Import it:

   ```bash
   npm run import -- "path/to/export"
   ```

3. Check it locally with `npm run dev`, then:

   ```bash
   git add -A && git commit -m "writeup: <name>" && git push
   ```

Pushing to `main` runs the tests, builds, and deploys. That's the whole loop.

### Options

| Flag | Why |
|---|---|
| `--force` | Overwrite posts that already exist. |
| `--date YYYY-MM-DD` | Set `pubDate`. GitBook carries no dates at all. |
| `--tags a,b,c` | Set tags. Same reason. |
| `--assets <dir>` | Extra directory to search for images. Needed when importing a single file whose assets live elsewhere in the repo. |

Inputs can be directories or individual files, so you can import exactly the pages
you want:

```bash
npm run import -- "../CTF-Writeups/README.md" --date 2025-03-07 --tags "picoctf,web,crypto" --assets "../CTF-Writeups"
```

## What the importer does

Neither Notion nor GitBook produces markdown Astro can use directly. Both put the
title in an `# H1` and ship no frontmatter; beyond that they break differently:

- **Notion** puts a 32-char page id in every filename, URL-encodes image paths, and
  writes a `Date:`/`Tags:` property block under the title.
- **GitBook** writes image paths relative to the page's *URL* rather than the file,
  so a root-level `README.md` points outside the repo entirely. Paths with spaces
  get `<angle brackets>`, and deleted file attachments become `/broken/pages/<hash>`
  links whose only surviving clue is the link text.

Rather than special-casing either, every local link is resolved against a basename
index of the whole import, so an asset is found wherever it actually lives.

Images land in `src/content/writeups/<slug>/` so Astro optimizes them. Everything
else (CSVs, pcaps, binaries) goes to `public/assets/<slug>/` — Astro's markdown
pipeline only processes images, so a non-image next to a post is silently never
copied into the build, leaving a dead link.

It **skips files that already exist** — pass `--force` to overwrite. This is
deliberate: re-importing should not destroy frontmatter you hand-edited.

Anything it cannot resolve is reported as a warning rather than silently dropped.

## Layout

| Path | What |
|---|---|
| `src/content/writeups/` | The posts. One `.md` per writeup, plus a folder of its images. |
| `src/content.config.ts` | Frontmatter schema (`title`, `pubDate`, `tags`, optional `description`). |
| `src/pages/index.astro` | The writeup list. |
| `src/pages/[...slug].astro` | A single writeup. |
| `scripts/import-writeups.mjs` | The importer (Notion + GitBook). |

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

The importer reads `base` out of `astro.config.mjs` when writing links to files in
`public/`, so the value lives in exactly one place.
