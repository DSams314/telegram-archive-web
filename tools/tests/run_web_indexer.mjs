#!/usr/bin/env node
// Run the browser's indexer under Node, against a real folder.
//
//   node tools/tests/run_web_indexer.mjs <backup-root> <empty-out-dir> [--no-dedupe]
//
// Exists for the parity tests: the exact code the web version runs, pointed at
// the same archive the Python indexer reads, so their outputs can be compared
// file by file. Prints a JSON summary, including every file it opened -- the
// tests use that list to prove no media file is ever read.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runIndex } from '../../app/indexer/build.js';

class NodeSource {
  constructor(root) {
    this.root = root;
    this.opened = [];
  }

  full(rel) {
    return rel ? path.join(this.root, ...rel.split('/')) : this.root;
  }

  async list(rel) {
    try {
      const entries = await fs.readdir(this.full(rel), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
    } catch {
      return null;
    }
  }

  async isFile(rel) {
    try { return (await fs.stat(this.full(rel))).isFile(); } catch { return false; }
  }

  async text(rel) {
    this.opened.push(rel);
    return fs.readFile(this.full(rel), 'utf8');
  }

  async modified(rel) {
    try { return (await fs.stat(this.full(rel))).mtimeMs; } catch { return null; }
  }
}

class NodeSink {
  constructor(out) { this.out = out; }

  async begin() {
    // Refuse to write into a folder that already has something in it, rather
    // than clearing it: a mistyped path must never cost anyone a directory.
    const existing = await fs.readdir(this.out).catch(() => []);
    if (existing.length) throw new Error(`${this.out} is not empty`);
    await fs.mkdir(this.out, { recursive: true });
  }

  async put(rel, value) {
    const file = path.join(this.out, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
}

const [root, out, ...flags] = process.argv.slice(2);
if (!root || !out) {
  console.error('usage: run_web_indexer.mjs <backup-root> <empty-out-dir> [--no-dedupe]');
  process.exit(2);
}

const source = new NodeSource(path.resolve(root));
const result = await runIndex({
  source,
  sink: new NodeSink(path.resolve(out)),
  dedupe: !flags.includes('--no-dedupe'),
});
console.log(JSON.stringify({
  chats: result.chats,
  selfId: result.selfId,
  report: result.report,
  opened: source.opened,
}));
