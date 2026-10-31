// Headless check of symbol extraction against the Domain Pascal examples.
// Usage: node test/check-symbols.js [files...]   (defaults to the examples)
const fs = require('fs');
const path = require('path');
const { initParser, parse } = require('../out/parser');
const { extractSymbols, flattenSymbols, lookupInScope } = require('../out/symbols');

const KINDS = ['module', 'function', 'procedure', 'type', 'struct', 'enum', 'constant', 'variable', 'field', 'enumMember'];

function print(syms, indent = '') {
  for (const s of syms) {
    if (s.hidden) continue;
    const detail = s.detail ? `  ${s.detail}` : '';
    console.log(`${indent}${s.kind.padEnd(10)} ${s.name}${detail}   [${s.range.start.line + 1}-${s.range.end.line + 1}]`);
    print(s.children, indent + '  ');
  }
}

async function main() {
  await initParser(path.join(__dirname, '..', 'wasm'));
  let files = process.argv.slice(2);
  const verbose = files.length > 0;
  if (!files.length) {
    const dir = path.join(__dirname, '..', '..', 'tree-sitter-pascal', 'examples', 'domain-pascal');
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.pas')).map((f) => path.join(dir, f));
    files.push(path.join(__dirname, '..', 'examples', 'proc2.ins.pas'));
  }
  const totals = {};
  let failures = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const tree = parse(text);
    const syms = extractSymbols(tree.rootNode);
    const flat = flattenSymbols(syms);
    const counts = {};
    for (const s of flat) counts[s.kind] = (counts[s.kind] || 0) + 1;
    for (const k in counts) totals[k] = (totals[k] || 0) + counts[k];
    // Sanity: every procedure/function header found by a regex should be a symbol.
    const expected = (text.match(/^\s*(procedure|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gim) || []).map((m) =>
      m.trim().split(/\s+/)[1].toLowerCase()
    );
    const got = new Set(flat.filter((s) => s.kind === 'procedure' || s.kind === 'function').map((s) => s.lname));
    const missing = expected.filter((n) => !got.has(n));
    if (missing.length) failures++;
    const summary = KINDS.filter((k) => counts[k]).map((k) => `${k}=${counts[k]}`).join(' ');
    console.log(`${path.basename(f).padEnd(24)} ${summary}${missing.length ? '  MISSING: ' + missing.join(',') : ''}`);
    if (verbose) print(syms);
    tree.delete();
  }
  console.log('TOTAL', totals);

  // Scope lookup smoke test on a synthetic module.
  const src = `MODULE m;\nVAR g: integer;\nPROCEDURE p(a: integer);\nVAR x: integer;\nBEGIN\n  x := a + g;\nEND;\nBEGIN\nEND.\n`;
  const tree = parse(src);
  const syms = extractSymbols(tree.rootNode);
  const at = (line, ch, name) => lookupInScope(syms, { line, character: ch }, name).map((s) => `${s.kind}@${s.range.start.line + 1}`);
  const checks = [
    [at(5, 2, 'x'), 'variable@4'],
    [at(5, 7, 'a'), 'parameter@3'],
    [at(5, 11, 'g'), 'variable@2'],
    [at(5, 2, 'P'), 'procedure@3'],
  ];
  for (const [got, want] of checks) {
    const ok = got.join(',') === want;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} lookup -> ${got.join(',') || '(none)'} (want ${want})`);
  }
  tree.delete();
  if (failures) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
