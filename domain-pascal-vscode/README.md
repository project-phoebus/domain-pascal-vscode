# Domain Pascal for VS Code

Syntax highlighting and symbol navigation for Apollo's Domain Pascal.

## Features

- TextMate syntax highlighting (`.pas`, `.dp`).
- **Outline / breadcrumbs / Go to Symbol in Editor** (`Cmd/Ctrl+Shift+O`):
  modules, programs, routines (with their local declarations), types with
  record fields and enum members, constants and variables.
- **Go to Symbol in Workspace** (`Cmd/Ctrl+T`): every `.pas`/`.dp` file in the
  workspace is indexed in the background on activation.
- **Go to Definition** (`F12`, `Cmd/Ctrl`-click): resolves the identifier under
  the cursor in the innermost enclosing routine first (parameters, locals),
  then at module level, then across the workspace index. Identifiers are
  matched case-insensitively and may contain `$`.
- `F12` on a `%INCLUDE 'path'` string opens the included file. Absolute
  Domain/OS paths such as `/sys/ins/base.ins.pas` are resolved against each
  workspace folder and against `domainPascal.includeRoots`.

Parsing is done with the sibling `tree-sitter-pascal` grammar compiled to
WebAssembly (`wasm/tree-sitter-pascal.wasm`) and loaded through
`web-tree-sitter`, so no native modules are needed.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `domainPascal.workspaceIndex.enabled` | `true` | Build the workspace-wide symbol index. |
| `domainPascal.workspaceIndex.exclude` | `**/node_modules/**` | Glob to leave out of the index. |
| `domainPascal.includeRoots` | `[]` | Directories treated as `/` when resolving absolute `%INCLUDE` paths. |

Command: **Domain Pascal: Rebuild Workspace Symbol Index**.

## Building

```sh
npm install
npm test          # compiles and checks symbol extraction against the example files
npm run deploy    # packages domain-pascal.vsix and installs it into VS Code
```

### Regenerating the grammar

After changing `../tree-sitter-pascal/grammar.js`:

```sh
cd ../tree-sitter-pascal
npx tree-sitter generate
npx tree-sitter build --wasm -o ../domain-pascal-vscode/wasm/tree-sitter-pascal.wasm .
```

`tree-sitter build --wasm` needs either Emscripten or Docker (it pulls
`emscripten/emsdk` automatically).
