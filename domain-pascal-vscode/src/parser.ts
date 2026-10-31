// Loads the tree-sitter-pascal grammar (compiled to WebAssembly) and exposes a
// shared parser. No `vscode` dependency so tests can use it directly.

import * as path from 'path';
import Parser = require('web-tree-sitter');

let parser: Parser | undefined;
let language: Parser.Language | undefined;

/** `wasmDir` is the directory holding tree-sitter-pascal.wasm. */
export async function initParser(wasmDir: string): Promise<Parser> {
  if (parser) return parser;
  await Parser.init();
  language = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-pascal.wasm'));
  parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export function getParser(): Parser {
  if (!parser) throw new Error('parser not initialised');
  return parser;
}

export function parse(text: string, oldTree?: Parser.Tree): Parser.Tree {
  return getParser().parse(text, oldTree);
}
