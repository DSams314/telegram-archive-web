// Read-only views of the folder you chose, in the shape the indexer expects.
//
// Two ways a browser can hand over a folder, so two classes:
//
//   HandleSource    Chrome and Edge: a real folder handle, which can be
//                   reopened on later visits.
//   FileListSource  Safari, Firefox, Brave: a one-off list of the files in
//                   the folder, picked or dropped for this visit only.
//
// Neither class can write anything. Listing a folder and reading a file's
// size or date never downloads it, even on a cloud drive; only .text() and
// .file() read contents, and the indexer uses .text() on result.json and
// the HTML export pages alone.

const split = (rel) => {
  const at = rel.lastIndexOf('/');
  return at < 0 ? ['', rel] : [rel.slice(0, at), rel.slice(at + 1)];
};

export class HandleSource {
  constructor(root) {
    this.root = root;
    this.dirs = new Map([['', Promise.resolve(root)]]);
    this.listings = new Map();
  }

  dir(rel) {
    if (!this.dirs.has(rel)) {
      const [parentRel, name] = split(rel);
      this.dirs.set(rel, this.dir(parentRel).then(
        (parent) => (parent ? parent.getDirectoryHandle(name) : null),
      ).catch(() => null));
    }
    return this.dirs.get(rel);
  }

  /** name -> 'file' | 'dir' for one folder, read once and remembered. */
  names(rel) {
    if (!this.listings.has(rel)) {
      this.listings.set(rel, (async () => {
        const handle = await this.dir(rel);
        if (!handle) return null;
        const out = new Map();
        for await (const [name, entry] of handle.entries()) {
          out.set(name, entry.kind === 'directory' ? 'dir' : 'file');
        }
        return out;
      })().catch(() => null));
    }
    return this.listings.get(rel);
  }

  async list(rel) {
    const names = await this.names(rel);
    return names ? [...names].map(([name, kind]) => ({ name, kind })) : null;
  }

  async isFile(rel) {
    const [parentRel, name] = split(rel);
    const names = await this.names(parentRel);
    if (names?.get(name) === 'file') return true;
    if (!names) return false;
    // Not under that exact name. The operating system may still match it
    // (macOS ignores letter case), which is what the Python indexer sees too.
    try {
      const parent = await this.dir(parentRel);
      await parent.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async file(rel) {
    const [parentRel, name] = split(rel);
    const parent = await this.dir(parentRel);
    if (!parent) throw new Error('not found');
    return (await parent.getFileHandle(name)).getFile();
  }

  async text(rel) {
    return (await this.file(rel)).text();
  }

  async modified(rel) {
    return (await this.file(rel)).lastModified;
  }
}

export class FileListSource {
  /** `entries` is a list of [path inside the folder, File]. */
  constructor(entries) {
    this.files = new Map();
    this.folders = new Map([['', new Map()]]);
    for (const [rel, file] of entries) {
      const parts = rel.split('/').filter(Boolean);
      if (!parts.length) continue;
      const clean = parts.join('/');
      this.files.set(clean, file);
      let parent = '';
      for (let i = 0; i < parts.length; i += 1) {
        const name = parts[i];
        const here = parent ? `${parent}/${name}` : name;
        const kind = i === parts.length - 1 ? 'file' : 'dir';
        if (!this.folders.has(parent)) this.folders.set(parent, new Map());
        if (!this.folders.get(parent).has(name)) this.folders.get(parent).set(name, kind);
        if (kind === 'dir' && !this.folders.has(here)) this.folders.set(here, new Map());
        parent = here;
      }
    }
  }

  async list(rel) {
    const found = this.folders.get(rel);
    return found ? [...found].map(([name, kind]) => ({ name, kind })) : null;
  }

  async isFile(rel) {
    return this.files.has(rel);
  }

  async file(rel) {
    const found = this.files.get(rel);
    if (!found) throw new Error('not found');
    return found;
  }

  async text(rel) {
    return (await this.file(rel)).text();
  }

  async modified(rel) {
    return (await this.file(rel)).lastModified;
  }
}

/** A view of one sub-folder -- the Backups folder inside the one you chose. */
export class PrefixedSource {
  constructor(source, prefix) {
    this.source = source;
    this.prefix = prefix;
  }

  at(rel) {
    if (!this.prefix) return rel;
    return rel ? `${this.prefix}/${rel}` : this.prefix;
  }

  list(rel) { return this.source.list(this.at(rel)); }
  isFile(rel) { return this.source.isFile(this.at(rel)); }
  file(rel) { return this.source.file(this.at(rel)); }
  text(rel) { return this.source.text(this.at(rel)); }
  modified(rel) { return this.source.modified(this.at(rel)); }
}
