#!/usr/bin/env node
// Index the built-in demo archive through the real in-browser indexer, under
// Node, and print a summary. The demo's pictures are drawn in a browser, but
// its structure (chats, messages, which files each message points at) is plain
// data, so it can be checked here without a browser.

import { demoResultJsons, DEMO_MEDIA, DEMO_CONFIG } from '../../app/web/demo.js';
import { FileListSource, PrefixedSource } from '../../app/web/sources.js';
import { runIndex } from '../../app/indexer/build.js';

// Indexing never opens a media file, so a media entry only has to exist -- a
// stand-in with just enough shape for the source is fine.
const entries = [];
for (const [path, obj] of Object.entries(demoResultJsons())) {
  const text = JSON.stringify(obj);
  entries.push([path, { async text() { return text; }, lastModified: 0 }]);
}
for (const path of Object.keys(DEMO_MEDIA)) {
  entries.push([path, { async text() { return ''; }, lastModified: 0 }]);
}

const source = new PrefixedSource(new FileListSource(entries), 'Backups');
const store = new Map();
const result = await runIndex({
  source,
  sink: { async put(path, value) { store.set(path, value); } },
  selfId: DEMO_CONFIG.self.id,
});

const manifest = store.get('manifest.json');
console.log(JSON.stringify({
  chats: result.chats,
  selfId: result.selfId,
  names: manifest.chats.map((c) => c.name),
  media: Object.fromEntries(manifest.chats.map((c) => [c.name, c.media_counts])),
  missing: manifest.chats.reduce((n, c) => n + (c.media_counts.missing || 0), 0),
}));
