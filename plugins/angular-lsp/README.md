# angular-lsp

Angular language server plugin for Claude Code, providing code intelligence for Angular projects including templates and TypeScript files.

## Supported Extensions

`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.html`

## Features

- Go-to-definition in Angular templates (e.g. `{{title}}` jumps to the component property)
- Go-to-definition in TypeScript files (e.g. `signal` jumps to `@angular/core`)
- Hover information, find references, completions
- Angular-specific diagnostics (unused imports, missing signal invocations, etc.)

## How It Works

This plugin runs `@angular/language-server` behind an LSP proxy (`lsp-proxy.mjs`) that:

1. **Normalizes `file://` URIs** in client-to-server messages to a consistent `file:///D:/forward/slashes` format, working around inconsistent URI formats from the LSP client
2. **Passes `--ngProbeLocations` and `--tsProbeLocations`** pointing to the bundled `node_modules` so the server finds `@angular/language-service` and `typescript`
3. **Logs all LSP traffic** to `lsp-log.jsonl` (configurable via `ANGULAR_LSP_LOG_FILE` env var)

## Modification to `@angular/language-server`

The bundled `@angular/language-server@21.1.4` has one patch applied:

**`node_modules/@angular/language-server/index.js` line 247871:**
```diff
- angularOnly: true
+ angularOnly: false
```

The upstream default `angularOnly: true` is designed for VS Code, where a separate TypeScript extension handles `.ts` file intelligence and the Angular server only handles Angular-specific features (templates, decorators). In standalone LSP setups like Claude Code, there is no separate TypeScript extension, so `angularOnly: false` is required to enable TypeScript definition, hover, and completions for `.ts` files through the Angular server.

## Bundled Dependencies

- `@angular/language-server` 21.1.4 (patched)
- `@angular/language-service` 21.1.4
- `typescript` 5.9.3
