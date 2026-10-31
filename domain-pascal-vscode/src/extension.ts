import * as path from 'path';
import * as vscode from 'vscode';
import type Parser from 'web-tree-sitter';
import { WorkspaceIndex } from './index';
import { initParser, parse } from './parser';
import { extractSymbols, isIdentifier, lookupInScope, Range, Sym, SymKind } from './symbols';

const LANGUAGE = 'domain-pascal';
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;

const KIND_MAP: Record<SymKind, vscode.SymbolKind> = {
  module: vscode.SymbolKind.Module,
  function: vscode.SymbolKind.Function,
  procedure: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  type: vscode.SymbolKind.TypeParameter,
  struct: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  class: vscode.SymbolKind.Class,
  interface: vscode.SymbolKind.Interface,
  field: vscode.SymbolKind.Field,
  enumMember: vscode.SymbolKind.EnumMember,
  constant: vscode.SymbolKind.Constant,
  variable: vscode.SymbolKind.Variable,
  parameter: vscode.SymbolKind.Variable,
  property: vscode.SymbolKind.Property,
  label: vscode.SymbolKind.Key,
};

function toRange(r: Range): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function toDocumentSymbol(s: Sym): vscode.DocumentSymbol {
  const range = toRange(s.range);
  let sel = toRange(s.selectionRange);
  if (!range.contains(sel)) sel = range;
  const ds = new vscode.DocumentSymbol(s.name, s.detail, KIND_MAP[s.kind], range, sel);
  ds.children = s.children.filter((c) => !c.hidden).map(toDocumentSymbol);
  return ds;
}

/** Parse cache for open documents, keyed by uri, invalidated by version. */
class DocumentCache implements vscode.Disposable {
  private entries = new Map<string, { version: number; tree: Parser.Tree; syms: Sym[] }>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(vscode.workspace.onDidCloseTextDocument((d) => this.drop(d.uri)));
  }

  get(doc: vscode.TextDocument): { tree: Parser.Tree; syms: Sym[] } {
    const key = doc.uri.toString();
    const hit = this.entries.get(key);
    if (hit && hit.version === doc.version) return hit;
    const tree = parse(doc.getText(), hit?.tree);
    hit?.tree.delete();
    const entry = { version: doc.version, tree, syms: extractSymbols(tree.rootNode) };
    this.entries.set(key, entry);
    return entry;
  }

  private drop(uri: vscode.Uri): void {
    const key = uri.toString();
    const hit = this.entries.get(key);
    if (hit) {
      hit.tree.delete();
      this.entries.delete(key);
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.tree.delete();
    this.entries.clear();
    for (const d of this.disposables) d.dispose();
  }
}

/** Resolve the target of a `%INCLUDE 'path'` directive, if the cursor is on one. */
async function includeTarget(doc: vscode.TextDocument, tree: Parser.Tree, pos: vscode.Position): Promise<vscode.Location[] | undefined> {
  const node = tree.rootNode.descendantForPosition({ row: pos.line, column: pos.character });
  let str: Parser.SyntaxNode | null = node;
  while (str && str.type !== 'literalString') str = str.parent;
  if (!str || !str.parent || str.parent.type !== 'directive') return undefined;
  if (!str.parent.children.some((c) => c.type === 'dirInclude')) return undefined;

  const raw = str.text.replace(/^'|'$/g, '').replace(/''/g, "'");
  const candidates: vscode.Uri[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (raw.startsWith('/')) {
    // Domain/OS absolute paths such as /sys/ins/base.ins.pas: try each
    // workspace folder as the root, then the configured include roots.
    const roots = vscode.workspace.getConfiguration('domainPascal').get<string[]>('includeRoots', []);
    for (const r of roots) candidates.push(vscode.Uri.file(path.join(r, raw)));
    for (const f of folders) candidates.push(vscode.Uri.joinPath(f.uri, raw));
  } else {
    candidates.push(vscode.Uri.joinPath(doc.uri, '..', raw));
    for (const f of folders) candidates.push(vscode.Uri.joinPath(f.uri, raw));
  }
  for (const uri of candidates) {
    try {
      await vscode.workspace.fs.stat(uri);
      return [new vscode.Location(uri, new vscode.Position(0, 0))];
    } catch {
      /* try next */
    }
  }
  // Fall back to any workspace file with the same basename (case-insensitive).
  const base = path.posix.basename(raw);
  const found = await vscode.workspace.findFiles(`**/${base}`, undefined, 20);
  const matches = found.filter((u) => path.basename(u.fsPath).toLowerCase() === base.toLowerCase());
  if (matches.length) return matches.map((u) => new vscode.Location(u, new vscode.Position(0, 0)));
  return [];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Domain Pascal');
  context.subscriptions.push(output);

  try {
    await initParser(path.join(context.extensionPath, 'wasm'));
  } catch (err) {
    output.appendLine(`failed to load tree-sitter-pascal.wasm: ${String(err)}`);
    void vscode.window.showErrorMessage(`Domain Pascal: failed to load parser (${String(err)})`);
    return;
  }

  const cache = new DocumentCache();
  const index = new WorkspaceIndex(output);
  context.subscriptions.push(cache, index);

  const selector: vscode.DocumentSelector = { language: LANGUAGE };

  // Outline view, breadcrumbs, and "Go to Symbol in Editor" (Cmd/Ctrl+Shift+O).
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(doc) {
        return cache.get(doc).syms.filter((s) => !s.hidden).map(toDocumentSymbol);
      },
    })
  );

  // "Go to Symbol in Workspace" (Cmd/Ctrl+T, or "#" in the quick open box).
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        if (!index.ready) void index.ensureBuilt();
        return index.search(query).map(
          (s) =>
            new vscode.SymbolInformation(
              s.name,
              KIND_MAP[s.kind],
              s.containerName || path.basename(s.uri.fsPath),
              new vscode.Location(s.uri, toRange(s.selectionRange))
            )
        );
      },
    })
  );

  // "Go to Definition" (F12 / Cmd-click): current scope first, then module
  // level, then every other file in the workspace. Also follows %INCLUDE.
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(doc, pos) {
        const { tree, syms } = cache.get(doc);

        const inc = await includeTarget(doc, tree, pos);
        if (inc) return inc;

        const wordRange = doc.getWordRangeAtPosition(pos, IDENT_RE);
        if (!wordRange) return undefined;
        const word = doc.getText(wordRange);
        if (!isIdentifier(word)) return undefined;

        const local = lookupInScope(syms, { line: pos.line, character: pos.character }, word).filter(
          (s) => !toRange(s.selectionRange).isEqual(wordRange)
        );
        if (local.length) {
          return local.map((s) => new vscode.Location(doc.uri, toRange(s.selectionRange)));
        }

        if (!index.ready) await index.ensureBuilt();
        return index
          .lookup(word)
          .filter((s) => !(s.uri.toString() === doc.uri.toString() && toRange(s.selectionRange).isEqual(wordRange)))
          .map((s) => new vscode.Location(s.uri, toRange(s.selectionRange)));
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('domainPascal.rebuildIndex', async () => {
      await index.rebuild();
      void vscode.window.showInformationMessage(`Domain Pascal: indexed ${index.size} files.`);
    })
  );

  // Build the workspace index in the background so Cmd+T is ready when wanted.
  void index.ensureBuilt();
}

export function deactivate(): void {
  /* subscriptions are disposed by VS Code */
}
