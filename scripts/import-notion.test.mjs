import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, parseNotionMarkdown, rewriteAssetPaths, slugify, stripNotionId } from './import-notion.mjs';

// A realistic Notion database-page export: H1 title with a colon, property block,
// and an image whose path and alt text are both URL-encoded.
const FIXTURE = `# HTB: Cicada "easy" box

Date: September 2, 2026
Tags: windows, smb
Status: Done

Enumeration started with a full port scan.

![HTB%20Cicada%209f8e7d6c5b4a39281706f5e4d3c2b1a0/Untitled%201.png](HTB%20Cicada%209f8e7d6c5b4a39281706f5e4d3c2b1a0/Untitled%201.png)

\`\`\`bash
nmap -sC -sV 10.10.11.35
\`\`\`
`;

test('parses title, date and tags out of a Notion export', () => {
	const r = parseNotionMarkdown(FIXTURE, {
		filename: 'HTB Cicada 9f8e7d6c5b4a39281706f5e4d3c2b1a0.md',
		mtime: new Date('2020-01-01'),
	});
	assert.equal(r.title, 'HTB: Cicada "easy" box');
	assert.equal(r.date.getUTCFullYear(), 2026);
	assert.equal(r.date.getUTCMonth(), 8); // September
	assert.deepEqual(r.tags, ['windows', 'smb']);
	// The property block and the H1 must not survive into the body.
	assert.ok(!r.body.includes('Status: Done'));
	assert.ok(!r.body.includes('# HTB'));
	assert.ok(r.body.startsWith('Enumeration started'));
	assert.ok(r.body.includes('nmap -sC -sV'));
});

test('a colon-and-quote title survives YAML round-tripping', () => {
	// JSON.stringify is the escaper the importer uses; a valid YAML double-quoted
	// scalar must parse back to exactly the original string.
	const r = parseNotionMarkdown(FIXTURE, { filename: 'x.md' });
	assert.equal(JSON.parse(JSON.stringify(r.title)), 'HTB: Cicada "easy" box');
});

test('falls back to filename and mtime when there is no H1 or property block', () => {
	const mtime = new Date('2026-03-04T00:00:00Z');
	const r = parseNotionMarkdown('Just body text.\n', {
		filename: 'Some Page 9f8e7d6c5b4a39281706f5e4d3c2b1a0.md',
		mtime,
	});
	assert.equal(r.title, 'Some Page');
	assert.equal(r.date.toISOString(), mtime.toISOString());
	assert.deepEqual(r.tags, []);
	assert.equal(r.body, 'Just body text.');
});

test('does not mistake a body line for a property block', () => {
	const r = parseNotionMarkdown('# Title\n\nNote: this is prose, not a property.\n', {
		filename: 'a.md',
	});
	assert.ok(r.body.startsWith('Note: this is prose'));
	assert.deepEqual(r.tags, []);
});

test('rewrites encoded asset paths and cleans the junk alt text', () => {
	const { body } = parseNotionMarkdown(FIXTURE, { filename: 'a.md' });
	const assets = new Map([['Untitled 1.png', 'untitled-1.png']]);
	const r = rewriteAssetPaths(body, 'htb-cicada', assets);
	assert.ok(r.body.includes('![untitled-1](./htb-cicada/untitled-1.png)'));
	assert.ok(!r.body.includes('%20'));
});

test('leaves external links alone and flags cross-page links', () => {
	const assets = new Map();
	const r = rewriteAssetPaths(
		'[docs](https://example.com/a%20b) and [other](Other%20Page%209f8e7d6c5b4a39281706f5e4d3c2b1a0.md)',
		'slug',
		assets,
	);
	assert.ok(r.body.includes('https://example.com/a%20b'));
	assert.equal(r.warnings.length, 1);
});

test('slugify strips the Notion id and normalizes punctuation', () => {
	assert.equal(slugify('HTB Cicada 9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 'htb-cicada');
	assert.equal(slugify('pwn: "baby" rop!'), 'pwn-baby-rop');
	assert.equal(stripNotionId('Page 9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 'Page');
	// A title that merely ends in a short hex-ish word must not be truncated.
	assert.equal(slugify('Buffer overflow abc123'), 'buffer-overflow-abc123');
});

test('a calendar date does not drift a day when serialized', () => {
	// Regression: toISOString() on a locally-parsed "September 2, 2026" yields
	// 2026-09-01T18:30Z in UTC+5:30, which then renders as Sept 1.
	const r = parseNotionMarkdown(FIXTURE, { filename: 'a.md' });
	assert.equal(isoDate(r.date), '2026-09-02');
	// And the value Astro stores must render back as the same calendar day in UTC.
	const stored = new Date(isoDate(r.date));
	assert.equal(
		stored.toLocaleDateString('en-us', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
		'Sep 2',
	);
});
