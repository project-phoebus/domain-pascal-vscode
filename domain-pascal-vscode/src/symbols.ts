// Pure symbol extraction over a tree-sitter-pascal syntax tree.
// This module has no dependency on the `vscode` API so it can be exercised
// headlessly (see test/check-symbols.js).

import type Parser from 'web-tree-sitter';

type Node = Parser.SyntaxNode;

export type SymKind =
  | 'module'
  | 'function'
  | 'procedure'
  | 'method'
  | 'type'
  | 'struct'
  | 'enum'
  | 'class'
  | 'interface'
  | 'field'
  | 'enumMember'
  | 'constant'
  | 'variable'
  | 'parameter'
  | 'property'
  | 'label';

export interface Pos {
  line: number;
  character: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface Sym {
  name: string;
  kind: SymKind;
  /** Extra text shown next to the name (type, signature...). */
  detail: string;
  /** Full extent of the declaration (body included). */
  range: Range;
  /** Extent of just the name. */
  selectionRange: Range;
  children: Sym[];
  /** Not shown in the outline; only used for scope-aware definition lookup. */
  hidden: boolean;
  /** Visible from other files (module-level declarations, enum members, methods). */
  exported: boolean;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function rangeOf(n: Node): Range {
  return {
    start: { line: n.startPosition.row, character: n.startPosition.column },
    end: { line: n.endPosition.row, character: n.endPosition.column },
  };
}

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function mk(name: string, kind: SymKind, node: Node, nameNode: Node | null, opts: Partial<Sym> = {}): Sym {
  return {
    name,
    kind,
    detail: '',
    range: rangeOf(node),
    selectionRange: rangeOf(nameNode ?? node),
    children: [],
    hidden: false,
    exported: false,
    ...opts,
  };
}

/** Does `node` have a direct child of the given type? */
/** `childrenForFieldName` also yields the anonymous separators; keep identifiers only. */
function namesOf(node: Node, field = 'name'): Node[] {
  return node.childrenForFieldName(field).filter((c) => c.isNamed);
}

function hasChild(node: Node, type: string): boolean {
  return node.children.some((c) => c.type === type);
}

/** Unwrap `(type (declEnum ...))` style wrappers down to the interesting node. */
function unwrapType(node: Node | null): Node | null {
  let n = node;
  while (n && n.type === 'type' && n.namedChildCount === 1) {
    n = n.namedChildren[0];
  }
  return n;
}

function kindForType(typeNode: Node | null): SymKind {
  const t = unwrapType(typeNode);
  if (!t) return 'type';
  switch (t.type) {
    case 'declClass':
      if (hasChild(t, 'kRecord')) return 'struct';
      return 'class';
    case 'declIntf':
      return 'interface';
    case 'declEnum':
      return 'enum';
    case 'declSet': {
      // SET OF (a, b, c) — treat as an enum so the members show up.
      const inner = unwrapType(t.namedChildren.find((c) => c.type === 'type') ?? null);
      return inner && inner.type === 'declEnum' ? 'enum' : 'type';
    }
    default:
      return 'type';
  }
}

/**
 * Collect members (fields, enum values, methods, properties) that are declared
 * inside a type expression. Nested anonymous records produce nested symbols.
 */
function collectMembers(typeNode: Node | null, out: Sym[], exported: boolean): void {
  const t = unwrapType(typeNode);
  if (!t) return;
  const visit = (n: Node): void => {
    switch (n.type) {
      case 'declField': {
        const typeN = n.childForFieldName('type');
        for (const nameN of namesOf(n)) {
          const s = mk(nameN.text, 'field', n, nameN, { detail: typeN ? oneLine(typeN.text) : '' });
          collectMembers(typeN, s.children, false);
          out.push(s);
        }
        return;
      }
      case 'declVariant': {
        // CASE tag: tagType OF ... — the tag is itself a field.
        const nameN = n.childForFieldName('name');
        const typeN = n.childForFieldName('type');
        if (nameN) {
          out.push(mk(nameN.text, 'field', nameN, nameN, { detail: typeN ? oneLine(typeN.text) : '' }));
        }
        break; // keep walking: the variant clauses hold more fields
      }
      case 'declEnumValue': {
        const nameN = n.childForFieldName('name');
        if (nameN) out.push(mk(nameN.text, 'enumMember', n, nameN, { exported }));
        return;
      }
      case 'declProc': {
        const nameN = n.childForFieldName('name');
        if (nameN) out.push(mk(nameN.text, 'method', n, nameN, { detail: procDetail(n), exported }));
        return;
      }
      case 'declProp': {
        const nameN = n.childForFieldName('name');
        const typeN = n.childForFieldName('type');
        if (nameN) out.push(mk(nameN.text, 'property', n, nameN, { detail: typeN ? oneLine(typeN.text) : '' }));
        return;
      }
      case 'block':
      case 'blockTr':
        return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(t);
}

function procDetail(declProc: Node): string {
  const isFunction = hasChild(declProc, 'kFunction');
  const args = declProc.childForFieldName('args');
  const ret = declProc.childForFieldName('type');
  let s = isFunction ? 'function' : 'procedure';
  if (args) s += oneLine(args.text, 50);
  if (ret) s += ': ' + oneLine(ret.text, 30);
  return s;
}

function procKind(declProc: Node): SymKind {
  return hasChild(declProc, 'kFunction') ? 'function' : 'procedure';
}

/** Parameters of a procedure header, as hidden symbols for scope lookup. */
function collectParams(declProc: Node, out: Sym[]): void {
  const args = declProc.childForFieldName('args');
  if (!args) return;
  for (const arg of args.descendantsOfType('declArg')) {
    const typeN = arg.childForFieldName('type');
    for (const nameN of namesOf(arg)) {
      out.push(mk(nameN.text, 'parameter', arg, nameN, { hidden: true, detail: typeN ? oneLine(typeN.text) : '' }));
    }
  }
  const resultName = declProc.childForFieldName('resultName');
  if (resultName) out.push(mk(resultName.text, 'variable', resultName, resultName, { hidden: true }));
}

/**
 * Walk a declaration region. `exported` is true at module level, false inside
 * a routine's local declarations.
 */
function collectDecls(node: Node, out: Sym[], exported: boolean): void {
  switch (node.type) {
    case 'program':
    case 'unit':
    case 'library':
    case 'module': {
      const nameN = node.namedChildren.find((c) => c.type === 'moduleName') ?? null;
      const s = mk(nameN ? nameN.text : node.type, 'module', node, nameN, { detail: node.type });
      for (const c of node.namedChildren) {
        if (c.id !== nameN?.id) collectDecls(c, s.children, true);
      }
      out.push(s);
      return;
    }

    case 'defProc': {
      const header = node.childForFieldName('header');
      const nameN = header?.childForFieldName('name') ?? null;
      const s = mk(
        nameN ? nameN.text : '<anonymous>',
        header ? procKind(header) : 'procedure',
        node,
        nameN,
        { detail: header ? procDetail(header) : '', exported }
      );
      if (header) collectParams(header, s.children);
      const body = node.childForFieldName('body');
      for (const c of node.namedChildren) {
        if (c.id === header?.id || c.id === body?.id) continue;
        collectDecls(c, s.children, false);
      }
      out.push(s);
      return;
    }

    case 'declProc': {
      // Forward / EXTERN declaration (what .ins.pas include files are made of).
      const nameN = node.childForFieldName('name');
      const s = mk(nameN ? nameN.text : '<anonymous>', procKind(node), node, nameN, {
        detail: procDetail(node),
        exported,
      });
      collectParams(node, s.children);
      out.push(s);
      return;
    }

    case 'declType': {
      const nameN = node.childForFieldName('name');
      const typeN = node.childForFieldName('type');
      if (!nameN) return;
      const s = mk(nameN.text, kindForType(typeN), node, nameN, { exported });
      if (s.kind === 'type' && typeN) s.detail = oneLine(typeN.text);
      collectMembers(typeN, s.children, exported);
      out.push(s);
      return;
    }

    case 'declConst': {
      const typeN = node.childForFieldName('type');
      const valN = node.childForFieldName('defaultValue');
      for (const nameN of namesOf(node)) {
        const detail = typeN ? oneLine(typeN.text) : valN ? oneLine(valN.text.replace(/^\s*=\s*/, '')) : '';
        out.push(mk(nameN.text, 'constant', node, nameN, { detail, exported }));
      }
      return;
    }

    case 'declVar': {
      const typeN = node.childForFieldName('type');
      for (const nameN of namesOf(node)) {
        const s = mk(nameN.text, 'variable', node, nameN, { detail: typeN ? oneLine(typeN.text) : '', exported });
        collectMembers(typeN, s.children, false);
        out.push(s);
      }
      return;
    }

    case 'declLabel': {
      const nameN = node.childForFieldName('name') ?? node;
      out.push(mk(nameN.text, 'label', node, nameN, { hidden: true }));
      return;
    }

    // DEFINE lists re-export names declared elsewhere in the module; the real
    // definitions are the routines themselves, so don't duplicate them.
    case 'declDefines':
    case 'declUses':
    case 'declExports':
    case 'declArgs':
    case 'block':
    case 'blockTr':
    case 'comment':
    case 'directive':
    case 'pp':
      return;

    case 'ERROR':
      recoverFromError(node, out, exported);
      for (const c of node.namedChildren) collectDecls(c, out, exported);
      return;

    default:
      // Transparent containers: root, interface, implementation,
      // declSection, declTypes, declVars, declConsts, declLabels, ...
      for (const c of node.namedChildren) collectDecls(c, out, exported);
      return;
  }
}

/**
 * The grammar does not yet know every Domain Pascal construct (EXTERN, IN
 * parameters, UNIV, 16#.. literals, ...). When a routine header fails to
 * parse, tree-sitter leaves its pieces as loose children of an ERROR node:
 *   (ERROR (kProcedure) name: (identifier) args: (declArgs ...) ...)
 * Recover a symbol from a keyword immediately followed by an identifier.
 */
function recoverFromError(node: Node, out: Sym[], exported: boolean): void {
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    const kw = kids[i];
    if (kw.type !== 'kProcedure' && kw.type !== 'kFunction') continue;
    const nameN = kids[i + 1];
    if (!nameN || nameN.type !== 'identifier') continue;
    let last: Node = nameN;
    let args: Node | null = null;
    const next = kids[i + 2];
    if (next && next.type === 'declArgs') {
      args = next;
      last = next;
    }
    const s = mk(nameN.text, kw.type === 'kFunction' ? 'function' : 'procedure', kw, nameN, { exported });
    s.range.end = rangeOf(last).end;
    s.detail = (kw.type === 'kFunction' ? 'function' : 'procedure') + (args ? oneLine(args.text, 50) : '');
    if (args) {
      for (const arg of args.descendantsOfType('declArg')) {
        const typeN = arg.childForFieldName('type');
        for (const n of namesOf(arg)) {
          s.children.push(mk(n.text, 'parameter', arg, n, { hidden: true, detail: typeN ? oneLine(typeN.text) : '' }));
        }
      }
    }
    out.push(s);
  }
}

/** Build the hierarchical symbol tree for a parsed file. */
export function extractSymbols(root: Node): Sym[] {
  const out: Sym[] = [];
  collectDecls(root, out, true);
  sortByPosition(out);
  return out;
}

/** Error recovery can emit symbols out of order; keep the outline in file order. */
function sortByPosition(list: Sym[]): void {
  list.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  for (const s of list) sortByPosition(s.children);
}

export interface FlatSym {
  name: string;
  lname: string;
  kind: SymKind;
  detail: string;
  range: Range;
  selectionRange: Range;
  containerName: string;
  exported: boolean;
}

/** Flatten a symbol tree (outline-visible symbols only). */
export function flattenSymbols(syms: Sym[], containerName = ''): FlatSym[] {
  const out: FlatSym[] = [];
  const visit = (s: Sym, container: string): void => {
    if (!s.hidden) {
      out.push({
        name: s.name,
        lname: s.name.toLowerCase(),
        kind: s.kind,
        detail: s.detail,
        range: s.range,
        selectionRange: s.selectionRange,
        containerName: container,
        exported: s.exported,
      });
    }
    const inner = s.kind === 'module' || container === '' ? s.name : `${container}.${s.name}`;
    for (const c of s.children) visit(c, inner);
  };
  for (const s of syms) visit(s, containerName);
  return out;
}

function contains(r: Range, p: Pos): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line && p.character > r.end.character) return false;
  return true;
}

/**
 * Scope-aware lookup of `name` (case-insensitive) from `pos`: innermost
 * enclosing routine first, then outward to module level. Returns every match
 * at the first level that has any.
 */
export function lookupInScope(syms: Sym[], pos: Pos, name: string): Sym[] {
  const lname = name.toLowerCase();
  // Chain of symbols whose range contains pos, outermost first.
  const chain: Sym[][] = [syms];
  let level = syms;
  for (;;) {
    const next = level.find((s) => s.children.length > 0 && contains(s.range, pos));
    if (!next) break;
    chain.push(next.children);
    level = next.children;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const hits = chain[i].filter((s) => s.name.toLowerCase() === lname);
    if (hits.length) return hits;
  }
  // Enum members and nested-record fields live below the top level; sweep them last.
  const deep: Sym[] = [];
  const sweep = (list: Sym[]): void => {
    for (const s of list) {
      if (!s.hidden && s.name.toLowerCase() === lname && (s.kind === 'enumMember' || s.kind === 'field' || s.kind === 'method')) {
        deep.push(s);
      }
      sweep(s.children);
    }
  };
  sweep(syms);
  return deep;
}

export function isIdentifier(text: string): boolean {
  return IDENT_RE.test(text);
}

/** Subsequence ("fuzzy") match used for workspace symbol queries. */
export function fuzzyMatch(query: string, candidate: string): boolean {
  if (!query) return true;
  let qi = 0;
  for (let i = 0; i < candidate.length && qi < query.length; i++) {
    if (candidate[i] === query[qi]) qi++;
  }
  return qi === query.length;
}
