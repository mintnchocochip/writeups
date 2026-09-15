#!/usr/bin/env node
// Convert exported markdown writeups into Astro content-collection posts.
//
//   node scripts/import-writeups.mjs <dir-or-file> [...] [options]
//
//     --force            overwrite posts that already exist
//     --date YYYY-MM-DD  set pubDate (sources without date metadata)
//     --tags a,b,c       set tags
//     --assets <dir>     also search here for assets (repeatable); needed when
//                        importing single files whose images live elsewhere
//
// Handles the two shapes markdown exports actually come in:
//
//   Notion   `HTB Cicada 9f8e...0.md` + a sibling asset folder, URL-encoded
//            image paths, no frontmatter, title in an H1, and a property
//            block (Date:, Tags:) just under it.
//   GitBook  clean markdown, no frontmatter, title in an H1, images in a
//            shared `.gitbook/assets/` folder referenced as `../`, with
//            spaces wrapped in angle brackets: ![x](<../a/image 1.png>).
//
// Rather than special-casing either layout, every local link target is
// resolved relative to its own markdown file and copied if it exists.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'writeups');

// Notion appends a page id to every exported filename: 32 hex chars, or a dashed UUID.
const NOTION_ID =
	/[\s-]+(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Property keys Notion emits for a database page. The block under the H1 is only
// treated as frontmatter if at least one of these appears — otherwise a body that
// happens to start with "Note: ..." would get swallowed.
const KNOWN_PROPS = new Set([
	'date',
	'tags',
	'created',
	'status',
	'category',
	'platform',
	'difficulty',
]);

const PROP_LINE = /^([A-Za-z][A-Za-z0-9 _-]*):[ \t]*(.*)$/;

// Markdown link/image, with GitBook's <angle-bracket> form for paths with spaces.
const LINK = /(!?)\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(\s+"[^"]*")?\s*\)/g;

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|[#?])/i;

// Leading ./ and ../ segments. GitBook writes these relative to the page's URL,
// not the file's location on disk, so a root-level README.md ends up pointing
// outside the repository entirely. The path after them is still the truth.
const RELATIVE_PREFIX = /^(?:\.\.?\/)+/;

// Astro's markdown pipeline only optimizes images. Anything else (a pcap, a
// binary, a CSV) relative to a content file is silently never copied into the
// build, leaving a dead link — so those go to public/ and are linked absolutely.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const PUBLIC_ASSETS = path.join(process.cwd(), 'public', 'assets');

// Read `base` from astro.config.mjs so generated links match the deployed path
// without the value being written down in two places.
export function siteBase(configPath = path.join(process.cwd(), 'astro.config.mjs')) {
	try {
		const m = fs.readFileSync(configPath, 'utf8').match(/^\s*base:\s*['"]([^'"]*)['"]/m);
		return m ? m[1].replace(/\/$/, '') : '';
	} catch {
		return '';
	}
}

// Exports never write real alt text: Notion repeats the encoded path, GitBook writes
// the original upload name ("image.png") for every image regardless of the file it
// points at. An alt that is just a filename carries nothing, so replace it; anything
// else is prose the author actually wrote, and is kept.
const FILENAME_ALT = /^[^\/]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export function stripNotionId(name) {
	return name.replace(NOTION_ID, '');
}

export function slugify(str) {
	return (
		stripNotionId(str)
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'untitled'
	);
}

// YAML double-quoted scalars are JSON strings, so JSON.stringify is a correct
// escaper with no yaml dependency. This is what keeps `HTB: Cicada` and
// `pwn "baby" rop` from breaking the build.
const yamlString = (s) => JSON.stringify(String(s));

// Calendar dates carry no timezone. Serializing via toISOString() would shift them
// across the UTC boundary ("September 2" read in UTC+5:30 becomes 2026-09-01T18:30Z,
// which renders as Sept 1). Emit local calendar components as a date-only string;
// Astro coerces that to UTC midnight and FormattedDate renders in UTC, so the day
// survives any build machine.
export const isoDate = (d) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Two headings in a row saying the same thing ("# Pico CTF'25" then "## Pico CTF'25")
// is a GitBook export artifact. Compare on letters and digits only so near-misses
// like "Cyber Apocalypse'25" / "Cyber Apocalypse" still match.
const headingKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseWriteup(raw, { filename = '', mtime = new Date() } = {}) {
	const lines = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
	let i = 0;

	// 1. Title from the leading H1, falling back to the de-hashed filename.
	let title = stripNotionId(path.basename(filename, path.extname(filename))).trim();
	while (i < lines.length && lines[i].trim() === '') i++;
	if (i < lines.length && /^#\s+/.test(lines[i])) {
		title = lines[i].replace(/^#\s+/, '').trim();
		i++;
	}
	if (!title) title = 'Untitled';

	// 2. Notion's property block: contiguous `Key: Value` lines under the H1.
	const afterTitle = i;
	while (i < lines.length && lines[i].trim() === '') i++;
	const props = {};
	while (i < lines.length) {
		const m = lines[i].match(PROP_LINE);
		if (!m) break;
		props[m[1].trim().toLowerCase()] = m[2].trim();
		i++;
	}
	const isPropertyBlock = Object.keys(props).some((k) => KNOWN_PROPS.has(k));
	let bodyStart = isPropertyBlock ? i : afterTitle;

	// 3. Drop a redundant H2 that just restates the title.
	let j = bodyStart;
	while (j < lines.length && lines[j].trim() === '') j++;
	const dup = lines[j]?.match(/^##\s+(.*)$/);
	if (dup) {
		const a = headingKey(dup[1]);
		const b = headingKey(title);
		if (a && b && (a.startsWith(b) || b.startsWith(a))) bodyStart = j + 1;
	}

	// 4. Date from the Date/Created property, else the file's mtime.
	let date = new Date(mtime);
	if (isPropertyBlock) {
		const value = props.date || props.created;
		// Notion writes "September 2, 2026", sometimes a range "Sep 2, 2026 → Sep 3, 2026".
		const parsed = value ? new Date(value.split('→')[0].trim()) : null;
		if (parsed && !Number.isNaN(parsed.valueOf())) date = parsed;
	}

	const tags =
		isPropertyBlock && props.tags
			? props.tags.split(',').map((t) => t.trim()).filter(Boolean)
			: [];

	const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '').trimEnd();
	return { title, date, tags, body, props: isPropertyBlock ? props : {} };
}

// Every local (non-external) link in the body, decoded, in order of appearance.
// The link text comes along because it is the only surviving clue for GitBook's
// broken file links.
export function localTargets(body) {
	const out = [];
	const seen = new Set();
	for (const m of body.matchAll(LINK)) {
		const target = m[3] ?? m[4];
		if (!target || EXTERNAL.test(target)) continue;
		let decoded;
		try {
			decoded = decodeURIComponent(target);
		} catch {
			decoded = target;
		}
		if (seen.has(decoded)) continue;
		seen.add(decoded);
		out.push({ target: decoded, text: m[2] });
	}
	return out;
}

// Point every copied asset at its new location.
// `hrefs` maps a decoded target to the href that replaces it.
export function rewriteAssetPaths(body, hrefs) {
	const warnings = [];
	const out = body.replace(LINK, (full, bang, alt, angled, plain, titlePart) => {
		const target = angled ?? plain;
		if (!target || EXTERNAL.test(target)) return full;

		let decoded;
		try {
			decoded = decodeURIComponent(target);
		} catch {
			decoded = target;
		}

		const href = hrefs.get(decoded);
		if (!href) {
			if (/\.mdx?$/i.test(decoded)) {
				warnings.push(`link to another page left as-is: ${decoded}`);
			}
			return full;
		}

		// Notion's alt is the encoded path, so compare it decoded too.
		let altText = alt;
		try {
			altText = decodeURIComponent(alt);
		} catch {
			/* alt is not encoded */
		}
		const junkAlt = !alt || altText === decoded || FILENAME_ALT.test(altText);
		// Only images get generated alt text; a file link keeps its label.
		const cleanAlt =
			junkAlt && bang ? path.basename(href, path.extname(href)) : alt;
		return `${bang}[${cleanAlt}](${href}${titlePart || ''})`;
	});
	return { body: out, warnings };
}

// Index every file under the import roots by basename, so an asset can be found
// even when the link does not point at where it actually lives.
export function indexFiles(roots) {
	const index = new Map();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === '.git' || entry.name === 'node_modules') continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				const key = entry.name.toLowerCase();
				if (!index.has(key)) index.set(key, []);
				const hits = index.get(key);
				// Roots overlap freely (a file input plus --assets on its repo), so the
				// same path can be reached twice. Without this it looks like a collision.
				if (!hits.includes(full)) hits.push(full);
			}
		}
	};
	const walked = new Set();
	for (const root of roots) {
		const dir = fs.statSync(root).isDirectory() ? root : path.dirname(root);
		const key = path.resolve(dir);
		if (walked.has(key)) continue;
		walked.add(key);
		walk(dir);
	}
	return index;
}

// Find the file a link actually refers to. Three sources, in order of trust:
//   1. the path as written, relative to the markdown file
//   2. the same basename elsewhere in the import, preferring a path that ends with
//      the link's own tail (".gitbook/assets/image.png" beats a stray "image.png")
//   3. the link text, for GitBook's "/broken/pages/<hash>" dead file links, where
//      the text is the original filename and the path is gone
export function resolveTarget(target, linkText, mdDir, index, exists = fs.existsSync) {
	const direct = path.resolve(mdDir, target);
	if (exists(direct)) return { file: direct, ambiguous: false };

	const tail = target.replace(RELATIVE_PREFIX, '');
	const byName = (name) => {
		const hits = index.get(path.basename(name).toLowerCase());
		if (!hits || hits.length === 0) return null;
		if (hits.length === 1) return { file: hits[0], ambiguous: false };
		const norm = (p) => p.split(path.sep).join('/').toLowerCase();
		const preferred = hits.filter((h) => norm(h).endsWith(norm(name)));
		if (preferred.length === 1) return { file: preferred[0], ambiguous: false };
		return { file: (preferred[0] ?? hits[0]), ambiguous: true };
	};

	// Markdown escapes underscores in link text: Ashen\_Outpost\_Records.csv
	const fromText = linkText ? linkText.replace(/\\(.)/g, '$1').trim() : '';
	return byName(tail) ?? (fromText ? byName(fromText) : null);
}

function uniqueName(taken, candidate) {
	if (!taken.has(candidate)) return candidate;
	const ext = path.extname(candidate);
	const stem = ext ? candidate.slice(0, -ext.length) : candidate;
	for (let n = 2; ; n++) {
		const next = `${stem}-${n}${ext}`;
		if (!taken.has(next)) return next;
	}
}

function collectMarkdown(target, found = []) {
	const stat = fs.statSync(target);
	if (stat.isFile()) {
		found.push(target);
		return found;
	}
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		if (entry.name === '.git' || entry.name === 'node_modules') continue;
		const full = path.join(target, entry.name);
		if (entry.isDirectory()) collectMarkdown(full, found);
		// SUMMARY.md is GitBook's table of contents, not a writeup.
		else if (entry.isFile() && /\.mdx?$/i.test(entry.name) && entry.name !== 'SUMMARY.md') {
			found.push(full);
		}
	}
	return found;
}

function parseArgs(argv) {
	const opts = { force: false, date: null, tags: null, inputs: [], assets: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--force') opts.force = true;
		else if (a === '--date') opts.date = argv[++i];
		else if (a === '--tags') opts.tags = argv[++i];
		else if (a === '--assets') opts.assets.push(argv[++i]);
		else opts.inputs.push(a);
	}
	return opts;
}

function main(argv) {
	const opts = parseArgs(argv);
	if (opts.inputs.length === 0) {
		console.error(
			'usage: node scripts/import-writeups.mjs <dir-or-file> [...] [--force] [--date YYYY-MM-DD] [--tags a,b,c] [--assets <dir>]',
		);
		process.exit(1);
	}

	let overrideDate = null;
	if (opts.date) {
		overrideDate = new Date(`${opts.date}T00:00:00`);
		if (Number.isNaN(overrideDate.valueOf())) {
			console.error(`--date must be YYYY-MM-DD, got: ${opts.date}`);
			process.exit(1);
		}
	}
	const overrideTags = opts.tags
		? opts.tags.split(',').map((t) => t.trim()).filter(Boolean)
		: null;

	const files = [];
	for (const input of opts.inputs) {
		if (!fs.existsSync(input)) {
			console.error(`no such file or directory: ${input}`);
			process.exit(1);
		}
		collectMarkdown(input, files);
	}
	if (files.length === 0) {
		console.error('no .md files found');
		process.exit(1);
	}

	fs.mkdirSync(CONTENT_DIR, { recursive: true });
	const index = indexFiles([...opts.inputs, ...opts.assets]);
	const base = siteBase();
	const usedSlugs = new Set();
	let written = 0;
	let skipped = 0;

	for (const file of files) {
		const raw = fs.readFileSync(file, 'utf8');
		const parsed = parseWriteup(raw, { filename: file, mtime: fs.statSync(file).mtime });

		// Slug from the title, not the filename: GitBook's entry page is README.md.
		let slug = slugify(parsed.title);
		if (usedSlugs.has(slug)) {
			const next = uniqueName(usedSlugs, slug);
			console.warn(`  ! duplicate slug ${slug}, using ${next}`);
			slug = next;
		}
		usedSlugs.add(slug);

		const dest = path.join(CONTENT_DIR, `${slug}.md`);
		// Re-importing after hand-editing frontmatter must not silently destroy that work.
		if (fs.existsSync(dest) && !opts.force) {
			console.log(`- skip   ${slug} (already exists; --force to overwrite)`);
			skipped++;
			continue;
		}

		// Resolve each local link to a real file and copy it in. Covers a Notion
		// sibling folder, a GitBook shared assets folder, and GitBook's broken file
		// links, without needing to know which layout it is looking at.
		const mdDir = path.dirname(file);
		const hrefs = new Map();
		const taken = new Set();
		const missing = [];
		let files = 0;
		for (const { target, text } of localTargets(parsed.body)) {
			const hit = resolveTarget(target, text, mdDir, index);
			if (!hit || !fs.existsSync(hit.file) || !fs.statSync(hit.file).isFile()) {
				if (!/\.mdx?$/i.test(target)) missing.push(target);
				continue;
			}
			if (hit.ambiguous) {
				console.warn(`  ! several files named ${path.basename(hit.file)}, used ${hit.file}`);
			}
			const ext = path.extname(hit.file);
			const name = uniqueName(
				taken,
				`${slugify(path.basename(hit.file, ext))}${ext.toLowerCase()}`,
			);
			taken.add(name);

			if (IMAGE_EXT.test(ext)) {
				// Beside the post, so Astro optimizes it.
				const dir = path.join(CONTENT_DIR, slug);
				fs.mkdirSync(dir, { recursive: true });
				fs.copyFileSync(hit.file, path.join(dir, name));
				hrefs.set(target, `./${slug}/${name}`);
			} else {
				// Into public/, served verbatim under the site base.
				const dir = path.join(PUBLIC_ASSETS, slug);
				fs.mkdirSync(dir, { recursive: true });
				fs.copyFileSync(hit.file, path.join(dir, name));
				hrefs.set(target, `${base}/assets/${slug}/${name}`);
				files++;
			}
		}

		const { body, warnings } = rewriteAssetPaths(parsed.body, hrefs);
		const frontmatter = [
			'---',
			`title: ${yamlString(parsed.title)}`,
			`pubDate: ${yamlString(isoDate(overrideDate || parsed.date))}`,
			`tags: [${(overrideTags || parsed.tags).map(yamlString).join(', ')}]`,
			'---',
			'',
		].join('\n');

		fs.writeFileSync(dest, frontmatter + body + '\n', 'utf8');
		written++;
		const images = hrefs.size - files;
		const counts = [`${images} image${images === 1 ? '' : 's'}`];
		if (files) counts.push(`${files} file${files === 1 ? '' : 's'}`);
		console.log(`+ import ${slug}  (${counts.join(', ')})`);
		for (const w of warnings) console.warn(`  ! ${w}`);
		for (const m of missing) console.warn(`  ! asset not found, left as-is: ${m}`);
	}

	console.log(`\n${written} written, ${skipped} skipped -> src/content/writeups/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2));
}
