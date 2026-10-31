// Workspace-wide symbol index: every *.pas / *.dp file in the workspace is
// parsed once (and re-parsed on change) and its outline-visible symbols kept
// in memory. Only `exported` symbols (module-level declarations, enum members,
// methods) are indexed, since locals are never reachable from other files.

import * as vscode from 'vscode';
import { parse } from './parser';
import { extractSymbols, flattenSymbols, FlatSym, fuzzyMatch } from './symbols';

export interface IndexedSym extends FlatSym {
  uri: vscode.Uri;
}

interface FileEntry {
  mtime: number;
  syms: IndexedSym[];
}

const decoder = new TextDecoder('utf-8');

export class WorkspaceIndex implements vscode.Disposable {
  private files = new Map<string, FileEntry>();
  private byName = new Map<string, IndexedSym[]>();
  private building: Promise<void> | undefined;
  private disposables: vscode.Disposable[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private status: vscode.StatusBarItem;

  constructor(private readonly output: vscode.OutputChannel) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.disposables.push(this.status);

    const glob = '**/*.{pas,PAS,Pas,dp,DP}';
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    watcher.onDidCreate((uri) => this.scheduleFile(uri));
    watcher.onDidChange((uri) => this.scheduleFile(uri));
    watcher.onDidDelete((uri) => this.removeFile(uri));
    this.disposables.push(watcher);

    // Keep the index in sync with unsaved edits in open editors.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'domain-pascal') this.scheduleFile(e.document.uri);
      })
    );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebuild();
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
  }

  get size(): number {
    return this.files.size;
  }

  get ready(): boolean {
    return this.building === undefined && this.files.size > 0;
  }

  /** Build the index if it has never been built; returns when done. */
  ensureBuilt(): Promise<void> {
    if (this.building) return this.building;
    if (this.files.size > 0) return Promise.resolve();
    return this.rebuild();
  }

  rebuild(): Promise<void> {
    if (this.building) return this.building;
    this.files.clear();
    this.byName.clear();
    this.building = this.buildAll().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async buildAll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('domainPascal');
    if (!cfg.get<boolean>('workspaceIndex.enabled', true)) return;
    const exclude = cfg.get<string>('workspaceIndex.exclude', '**/node_modules/**');

    const started = Date.now();
    const uris = await vscode.workspace.findFiles('**/*.{pas,PAS,Pas,dp,DP}', exclude || undefined);
    if (uris.length === 0) return;

    this.status.text = `$(sync~spin) Domain Pascal: indexing 0/${uris.length}`;
    this.status.show();
    let done = 0;
    let failed = 0;
    for (const uri of uris) {
      try {
        await this.indexFile(uri);
      } catch (err) {
        failed++;
        this.output.appendLine(`index: ${uri.fsPath}: ${String(err)}`);
      }
      done++;
      if (done % 50 === 0) {
        this.status.text = `$(sync~spin) Domain Pascal: indexing ${done}/${uris.length}`;
      }
    }
    this.status.hide();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    this.output.appendLine(
      `index: ${done} files, ${this.byName.size} distinct names, ${failed} failures, ${secs}s`
    );
  }

  private scheduleFile(uri: vscode.Uri): void {
    const key = uri.toString();
    const t = this.pending.get(key);
    if (t) clearTimeout(t);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.indexFile(uri, true).catch((err) => this.output.appendLine(`index: ${uri.fsPath}: ${String(err)}`));
      }, 300)
    );
  }

  private removeFile(uri: vscode.Uri): void {
    const key = uri.toString();
    const entry = this.files.get(key);
    if (!entry) return;
    this.files.delete(key);
    for (const s of entry.syms) {
      const list = this.byName.get(s.lname);
      if (!list) continue;
      const rest = list.filter((x) => x.uri.toString() !== key);
      if (rest.length) this.byName.set(s.lname, rest);
      else this.byName.delete(s.lname);
    }
  }

  private async indexFile(uri: vscode.Uri, force = false): Promise<void> {
    const key = uri.toString();
    // Prefer the live buffer of an open document.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    let text: string;
    let mtime: number;
    if (open) {
      text = open.getText();
      mtime = -open.version;
    } else {
      const stat = await vscode.workspace.fs.stat(uri);
      mtime = stat.mtime;
      if (!force && this.files.get(key)?.mtime === mtime) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = decoder.decode(bytes);
    }
    const tree = parse(text);
    try {
      const syms = flattenSymbols(extractSymbols(tree.rootNode))
        .filter((s) => s.exported)
        .map((s) => ({ ...s, uri }));
      this.removeFile(uri);
      this.files.set(key, { mtime, syms });
      for (const s of syms) {
        const list = this.byName.get(s.lname);
        if (list) list.push(s);
        else this.byName.set(s.lname, [s]);
      }
    } finally {
      tree.delete();
    }
  }

  /** Exact (case-insensitive) name lookup. */
  lookup(name: string): IndexedSym[] {
    return this.byName.get(name.toLowerCase()) ?? [];
  }

  /** Fuzzy search for the workspace symbol picker. */
  search(query: string, limit = 2000): IndexedSym[] {
    const q = query.toLowerCase();
    const out: IndexedSym[] = [];
    // Names that contain the query as a substring come first.
    const later: IndexedSym[] = [];
    for (const [lname, syms] of this.byName) {
      if (lname.includes(q)) {
        for (const s of syms) {
          out.push(s);
          if (out.length >= limit) return out;
        }
      } else if (fuzzyMatch(q, lname)) {
        for (const s of syms) later.push(s);
      }
    }
    for (const s of later) {
      if (out.length >= limit) break;
      out.push(s);
    }
    return out;
  }
}
