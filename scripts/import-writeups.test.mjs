import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isoDate,
	localTargets,
	parseWriteup,
	resolveTarget,
	siteBase,
	rewriteAssetPaths,
	slugify,
	stripNotionId,
} from './import-writeups.mjs';

// A Notion database-page export: H1 title with a colon, property block, and an
// image whose path and alt text are both URL-encoded.
const NOTION = `# HTB: Cicada "easy" box

Date: September 2, 2026
Tags: windows, smb
Status: Done

Enumeration started with a full port scan.

![HTB%20Cicada%209f8e7d6c5b4a39281706f5e4d3c2b1a0/Untitled%201.png](HTB%20Cicada%209f8e7d6c5b4a39281706f5e4d3c2b1a0/Untitled%201.png)

\`\`\`bash
nmap -sC -sV 10.10.11.35
\`\`\`
`;

// A GitBook export: no property block, a duplicate H2 restating the title, and
// images in a shared folder referenced with <angle brackets> because of spaces.
const GITBOOK = `# Pico CTF’25

## Pico CTF’25

## SSTI 1

Injected a template expression.

![image.png](<../.gitbook/assets/image 1.png>)

![image.png](../.gitbook/assets/plain.png)
`;

test('parses title, date and tags out of a Notion export', () => {
	const r = parseWriteup(NOTION, {
		filename: 'HTB Cicada 9f8e7d6c5b4a39281706f5e4d3c2b1a0.md',
		mtime: new Date('2020-01-01'),
	});
	assert.equal(r.title, 'HTB: Cicada "easy" box');
	assert.equal(isoDate(r.date), '2026-09-02');
	assert.deepEqual(r.tags, ['windows', 'smb']);
	assert.ok(!r.body.includes('Status: Done'));
	assert.ok(!r.body.includes('# HTB'));
	assert.ok(r.body.startsWith('Enumeration started'));
});

test('a colon-and-quote title survives YAML round-tripping', () => {
	const r = parseWriteup(NOTION, { filename: 'x.md' });
	assert.equal(JSON.parse(JSON.stringify(r.title)), 'HTB: Cicada "easy" box');
});

test('a calendar date does not drift a day when serialized', () => {
	// Regression: toISOString() on a locally-parsed "September 2, 2026" yields
	// 2026-09-01T18:30Z in UTC+5:30, which then renders as Sept 1.
	const r = parseWriteup(NOTION, { filename: 'a.md' });
	assert.equal(isoDate(r.date), '2026-09-02');
	const stored = new Date(isoDate(r.date));
	assert.equal(
		stored.toLocaleDateString('en-us', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
		'Sep 2',
	);
});

test('falls back to filename and mtime with no H1 or property block', () => {
	const mtime = new Date(2026, 2, 4);
	const r = parseWriteup('Just body text.\n', {
		filename: 'Some Page 9f8e7d6c5b4a39281706f5e4d3c2b1a0.md',
		mtime,
	});
	assert.equal(r.title, 'Some Page');
	assert.equal(isoDate(r.date), '2026-03-04');
	assert.equal(r.body, 'Just body text.');
});

test('does not mistake a body line for a property block', () => {
	const r = parseWriteup('# Title\n\nNote: this is prose, not a property.\n', { filename: 'a.md' });
	assert.ok(r.body.startsWith('Note: this is prose'));
	assert.deepEqual(r.tags, []);
});

test('drops a duplicate H2 that restates the title', () => {
	const r = parseWriteup(GITBOOK, { filename: 'README.md' });
	assert.equal(r.title, 'Pico CTF’25');
	assert.ok(r.body.startsWith('## SSTI 1'), `body began: ${r.body.slice(0, 40)}`);
	// The real section heading must survive.
	assert.ok(r.body.includes('## SSTI 1'));
});

test('keeps an H2 that is a genuine section, not a restated title', () => {
	const r = parseWriteup('# My Writeup\n\n## Enumeration\n\nbody\n', { filename: 'a.md' });
	assert.ok(r.body.startsWith('## Enumeration'));
});

test('finds local targets in both plain and angle-bracket form', () => {
	assert.deepEqual(
		localTargets(GITBOOK).map((t) => t.target),
		['../.gitbook/assets/image 1.png', '../.gitbook/assets/plain.png'],
	);
});

test('ignores external and anchor targets', () => {
	const body = '[a](https://example.com/x) [b](mailto:x@y.z) [c](#section) [d](//cdn/x.png)';
	assert.deepEqual(localTargets(body), []);
});

// resolveTarget is given a fake index and existence check so these stay pure.
const INDEX = new Map([
	['image.png', ['/repo/.gitbook/assets/image.png', '/repo/PicoCTF 2025/image.png']],
	['image 1.png', ['/repo/.gitbook/assets/image 1.png']],
	['ashen_outpost_records.csv', ['/repo/Cyber Apocalypse 2025/Ashen_Outpost_Records.csv']],
]);
const nothingExists = () => false;

test('finds an asset when GitBook ../ points outside the repo', () => {
	// README.md sits at the repo root, so "../" escapes it entirely.
	const r = resolveTarget('../.gitbook/assets/image 1.png', 'image.png', '/repo', INDEX, nothingExists);
	assert.equal(r.file, '/repo/.gitbook/assets/image 1.png');
	assert.equal(r.ambiguous, false);
});

test('disambiguates a repeated basename using the link tail', () => {
	// Three files are named image.png; the one under .gitbook/assets is meant.
	const r = resolveTarget('../.gitbook/assets/image.png', 'image.png', '/repo', INDEX, nothingExists);
	assert.equal(r.file, '/repo/.gitbook/assets/image.png');
	assert.equal(r.ambiguous, false);
});

test('recovers a GitBook broken file link from its link text', () => {
	const r = resolveTarget(
		'/broken/pages/449f2c23cbc18705046542ebfd09cfdffdf350ab',
		'Ashen\\_Outpost\\_Records.csv',
		'/repo/write-ups',
		INDEX,
		nothingExists,
	);
	assert.equal(r.file, '/repo/Cyber Apocalypse 2025/Ashen_Outpost_Records.csv');
});

test('returns null when nothing matches', () => {
	assert.equal(resolveTarget('missing.png', 'missing.png', '/repo', INDEX, nothingExists), null);
});

test('prefers the path as written when it exists on disk', () => {
	const r = resolveTarget('assets/x.png', 'x.png', '/repo', INDEX, (p) => p.endsWith('x.png'));
	assert.ok(r.file.endsWith('x.png'));
	assert.equal(r.ambiguous, false);
});

test('rewrites angle-bracket GitBook paths and cleans junk alt text', () => {
	const { body } = parseWriteup(GITBOOK, { filename: 'README.md' });
	const hrefs = new Map([
		['../.gitbook/assets/image 1.png', './pico-ctf-25/image-1.png'],
		['../.gitbook/assets/plain.png', './pico-ctf-25/plain.png'],
	]);
	const r = rewriteAssetPaths(body, hrefs);
	assert.ok(r.body.includes('![image-1](./pico-ctf-25/image-1.png)'));
	assert.ok(r.body.includes('![plain](./pico-ctf-25/plain.png)'));
	assert.ok(!r.body.includes('.gitbook'));
	assert.ok(!r.body.includes('<'));
});

test('rewrites URL-encoded Notion paths', () => {
	const { body } = parseWriteup(NOTION, { filename: 'a.md' });
	const hrefs = new Map([
		['HTB Cicada 9f8e7d6c5b4a39281706f5e4d3c2b1a0/Untitled 1.png', './htb-cicada/untitled-1.png'],
	]);
	const r = rewriteAssetPaths(body, hrefs);
	assert.ok(r.body.includes('![untitled-1](./htb-cicada/untitled-1.png)'));
	assert.ok(!r.body.includes('%20'));
});

test('leaves external links alone and flags cross-page links', () => {
	const r = rewriteAssetPaths(
		'[docs](https://example.com/a%20b) and [other](Other%20Page.md)',
		new Map(),
	);
	assert.ok(r.body.includes('https://example.com/a%20b'));
	assert.equal(r.warnings.length, 1);
});

test('slugify strips the Notion id and normalizes punctuation', () => {
	assert.equal(slugify('HTB Cicada 9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 'htb-cicada');
	assert.equal(slugify('pwn: "baby" rop!'), 'pwn-baby-rop');
	assert.equal(slugify('Pico CTF’25'), 'pico-ctf-25');
	assert.equal(stripNotionId('Page 9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 'Page');
	// A title that merely ends in a short hex-ish word must not be truncated.
	assert.equal(slugify('Buffer overflow abc123'), 'buffer-overflow-abc123');
});

test('a non-image file link keeps its label and gets an absolute href', () => {
	// Astro does not copy non-image assets out of src/, so these live in public/
	// and are linked under the site base instead of relative to the post.
	const r = rewriteAssetPaths(
		'[Ashen\_Outpost\_Records.csv](/broken/pages/449f2c)',
		new Map([['/broken/pages/449f2c', '/writeups/assets/cyber/ashen-outpost-records.csv']]),
	);
	assert.equal(
		r.body,
		'[Ashen\_Outpost\_Records.csv](/writeups/assets/cyber/ashen-outpost-records.csv)',
	);
});

test('siteBase reads base out of astro.config.mjs', () => {
	assert.equal(siteBase(), '/writeups');
	assert.equal(siteBase('does-not-exist.mjs'), '');
});
