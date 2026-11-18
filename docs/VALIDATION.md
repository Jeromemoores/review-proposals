# Validation — 0.1.0

Validation host: Windows, Node.js 24.15.0, npm 12.0.1, installed VS Code 1.146.0. Type checking targets the stable VS Code 1.100.0 API. Compilation uses TypeScript 7.0.2. No proposed VS Code APIs are used.

## Executed checks

- `npm test`: 22 passing behavioral checks, covering immutable proposals, grouped submission, stale disk/unsaved editor contents, changes while documents open, failed and concurrent acceptance, rejection, persisted decisions, UTF-8/BOM/newlines, malformed input, path traversal/links, standalone CLI generation and managed companion-skill installation.
- `npm run test:integration`: eight checks passed in a real isolated VS Code extension host: read-only diff without source changes, rejection, same-proposal decision restoration, grouped editor-buffer edits without forced saves, native Undo, preservation of unsaved work, stale disk rejection, and installation/execution of the self-contained generator for both agents.
- Integration tests use their own workspace, editor user data, extension directory and home. They do not modify the user's projects or skill folders. Workspace Trust is disabled only for the disposable trusted test profile; untrusted-mode refusal is implemented with the stable trust API but was not exercised in a separate restricted-mode host.

`vsce package --no-dependencies --skip-license` produced the installable VSIX. Its payload was inspected for the runtime, schema and complete companion resources and absence of node_modules/test code. The packaged extension was extracted into an isolated location and passed the same eight real-editor checks, including installing and running the packaged standalone generator. Published-artifact verification and SHA-256 are recorded in the release notes. No license file was selected or added as part of this task; the packaging command preserves that choice.

## Limits

This is a first-version functional validation, not a guarantee of correctness or a full adversarial audit. Review and implementation ran in one agent context. macOS/Linux, remote/virtual workspace behavior, the declared minimum editor version, and every editor policy were not exercised. Existing text replacements are supported; binary assets and file creation/deletion/renaming are not.

The extension executes no proposed code or reported tests. Check statuses and documentation links remain agent supplied. Acceptance changes editor buffers; VS Code Save/Auto Save determines persistence. Normal editor Undo was exercised for a single-file acceptance; successful grouped application and whole-group stale refusal were exercised separately.

`npm audit --omit=dev` reports zero production dependencies/findings. The official packaging tool's development dependency tree currently reports five propagated findings (one moderate and four high), involving minimatch/picomatch. These dependencies are not bundled into the VSIX. No incompatible forced override or install-script policy change was applied. Relevant reports: https://github.com/advisories/GHSA-g3hv-75wg-m249 and https://github.com/advisories/GHSA-fc5q-39xc-vjpf.
