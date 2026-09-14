#!/usr/bin/env node
// Convert a Notion markdown export into Astro content-collection posts.
//
//   node scripts/import-notion.mjs <export-dir> [--force]
//
// Notion gives you `HTB Cicada 9f8e...0.md` next to an asset folder of the same
// name, no frontmatter, the title stuck in an H1, and URL-encoded image paths.
// This normalizes all of that into src/content/writeups/<slug>.md.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'writeups');

// Notion appends a page id to every exported filename: 32 hex chars, or a dashed UUID.
const NOTION_ID =
	/[\s-]+(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Property keys Notion emits for a database page. The block after the H1 is only
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

// Notion dates are calendar days with no timezone. Serializing via toISOString()
// would shift them across the UTC boundary ("September 2" imported in UTC+5:30
// becomes 2026-09-01T18:30Z, which renders as Sept 1). Emit the local calendar
// components as a date-only string; Astro coerces that to UTC midnight, and
// FormattedDate renders it in UTC, so the day survives any build machine.
export const isoDate = (d) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function parseNotionMarkdown(raw, { filename = '', mtime = new Date() } = {}) {
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

	// 2. Notion's property block: contiguous `Key: Value` lines after the H1.
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
	const bodyStart = isPropertyBlock ? i : afterTitle;

	// 3. Date from the Date/Created property, else the file's mtime.
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

// Rewrite Notion's URL-encoded asset paths to `./<slug>/<file>`.
// `assets` maps an original basename to its new, slugified filename.
export function rewriteAssetPaths(body, slug, assets) {
	const warnings = [];
	const out = body.replace(
		/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
		(full, bang, alt, target, titlePart) => {
			if (/^(https?:|mailto:|#|\/)/i.test(target)) return full;

			let decoded;
			try {
				decoded = decodeURIComponent(target);
			} catch {
				decoded = target;
			}

			const base = decoded.split('/').pop();
			const renamed = assets.get(base);
			if (renamed) {
				// Notion's alt text is usually just the encoded path again — useless as alt.
				let cleanAlt = alt;
				try {
					if (!alt || decodeURIComponent(alt) === decoded) {
						cleanAlt = path.basename(renamed, path.extname(renamed));
					}
				} catch {
					cleanAlt = path.basename(renamed, path.extname(renamed));
				}
				return `${bang}[${cleanAlt}](./${slug}/${renamed}${titlePart || ''})`;
			}
			if (/\.md$/i.test(decoded)) {
				warnings.push(`link to another exported page left as-is: ${decoded}`);
			}
			return full;
		},
	);
	return { body: out, warnings };
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

function walkMarkdown(dir, found = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(full, found);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
	}
	return found;
}

function main(argv) {
	const force = argv.includes('--force');
	const exportDir = argv.find((a) => !a.startsWith('--'));
	if (!exportDir) {
		console.error('usage: node scripts/import-notion.mjs <export-dir> [--force]');
		process.exit(1);
	}
	if (!fs.existsSync(exportDir)) {
		console.error(`no such directory: ${exportDir}`);
		process.exit(1);
	}

	fs.mkdirSync(CONTENT_DIR, { recursive: true });
	const files = walkMarkdown(exportDir);
	if (files.length === 0) {
		console.error(`no .md files found under ${exportDir}`);
		process.exit(1);
	}

	const usedSlugs = new Set();
	let written = 0;
	let skipped = 0;

	for (const file of files) {
		const stat = fs.statSync(file);
		const raw = fs.readFileSync(file, 'utf8');
		const parsed = parseNotionMarkdown(raw, { filename: file, mtime: stat.mtime });

		let slug = slugify(path.basename(file, '.md'));
		if (usedSlugs.has(slug)) {
			const next = uniqueName(usedSlugs, slug);
			console.warn(`  ! duplicate slug ${slug}, using ${next}`);
			slug = next;
		}
		usedSlugs.add(slug);

		const dest = path.join(CONTENT_DIR, `${slug}.md`);
		// Re-importing after hand-editing frontmatter must not silently destroy that work.
		if (fs.existsSync(dest) && !force) {
			console.log(`- skip   ${slug} (already exists; --force to overwrite)`);
			skipped++;
			continue;
		}

		// Copy the sibling asset folder, slugifying each filename.
		const assetSrc = file.slice(0, -3);
		const assets = new Map();
		if (fs.existsSync(assetSrc) && fs.statSync(assetSrc).isDirectory()) {
			const assetDest = path.join(CONTENT_DIR, slug);
			fs.mkdirSync(assetDest, { recursive: true });
			const taken = new Set();
			for (const name of fs.readdirSync(assetSrc)) {
				const from = path.join(assetSrc, name);
				if (!fs.statSync(from).isFile()) continue;
				const ext = path.extname(name);
				const renamed = uniqueName(
					taken,
					`${slugify(path.basename(name, ext))}${ext.toLowerCase()}`,
				);
				taken.add(renamed);
				assets.set(name, renamed);
				fs.copyFileSync(from, path.join(assetDest, renamed));
			}
		}

		const { body, warnings } = rewriteAssetPaths(parsed.body, slug, assets);
		const frontmatter = [
			'---',
			`title: ${yamlString(parsed.title)}`,
			`pubDate: ${yamlString(isoDate(parsed.date))}`,
			`tags: [${parsed.tags.map(yamlString).join(', ')}]`,
			'---',
			'',
		].join('\n');

		fs.writeFileSync(dest, frontmatter + body + '\n', 'utf8');
		written++;
		console.log(`+ import ${slug}  (${assets.size} asset${assets.size === 1 ? '' : 's'})`);
		for (const w of warnings) console.warn(`  ! ${w}`);
	}

	console.log(`\n${written} written, ${skipped} skipped -> src/content/writeups/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2));
}
