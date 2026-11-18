# Review Proposals

A VS Code companion for reviewing agent recommendations **before applying code changes**. Import a proposal, inspect the current-versus-proposed diff, read the explanation and evidence, then accept or reject each recommendation.

Works with proposals from Claude Code, Codex, or another agent using the same format. No model account, API key, server, or automatic repository upload is required by this extension. It complements the [Web and Unreal development skills](https://github.com/Jeromemoores/skills).

## Install

1. Download **review-proposals-0.1.0.vsix** from [Releases](https://github.com/Jeromemoores/review-proposals/releases/latest).
2. In VS Code, run **Extensions: Install from VSIX…** from the Command Palette and select it. Alternatively:

```sh
code --install-extension review-proposals-0.1.0.vsix
```

Open a project folder, then select **Review Proposals** in the activity bar. This package is distributed as a VSIX; it is not currently published in the Visual Studio Marketplace.

## Use with your coding agent

1. Run **Review Proposals: Install Companion Skill for Claude Code and Codex**. It installs `propose-code-review` into both agents' user skill folders; existing unrelated skills are preserved. An existing unmanaged skill with that name is preserved and reported rather than overwritten.
2. Run **Review Proposals: Copy Agent Review Instructions** and paste them into your agent with the review scope.
3. The agent reviews code, saves replacement files separately, and runs the bundled generator to create a proposal JSON. **Node.js 22+** is required to run that generator. The installed extension itself uses VS Code's runtime.
4. Run **Review Proposals: Import Proposal**, choose the JSON, and select the owning workspace in a multi-root window.
5. Expand a recommendation and click a file to open its diff. Use **Show Recommendation Details** for reasons, tradeoffs, documentation links and reported checks.
6. Select **Accept Recommendation** or **Reject Recommendation** beside the group. Related edits apply together. Normal VS Code Save/Auto Save and Undo behavior applies after acceptance; the extension does not force a save.

Examples: “Review this React component with the official stack/review skills and propose cohesive function boundaries.” Or: “Review this Unreal C++ system for lifecycle defects and code-supported efficiency opportunities; export proposals without changing source.”

## What the controls mean

| State | Meaning |
| --- | --- |
| Pending | Original disk/editor contents still match; the recommendation can be accepted. |
| Stale | A target changed, is unavailable, or is unsupported. Regenerate the proposal; acceptance is blocked. |
| Accepted | The grouped edit was accepted into editor buffers. This does not mean tests passed, files were committed, or runtime behavior was verified. |
| Rejected | The recommendation was dismissed without editing targets. |

Preview uses read-only virtual snapshots, not temporary edits to source files. Acceptance rechecks every target, including unsaved editor contents, immediately before submitting one text-only WorkspaceEdit. VS Code documents text-only edits as all-or-nothing. If two recommendations touch the same file, accepting one can make the other stale; v0.1 does not silently merge/rebase it. Use **Refresh Status** after external file changes; the final acceptance check always revalidates contents.

The extension does not execute agents, tests, shell commands, links, or code from proposals. Documentation URLs and test results are **agent supplied** and are not independently verified by the extension. It has no telemetry or network client. Installing the companion skill writes only its managed skill directories. Applying edits and installing the skill require Workspace Trust.

## First-version scope

Version 0.1 applies replacements to **existing UTF-8 text files within one filesystem workspace**. It supports web code, Unreal C++/headers, build/configuration files and other text. File creation/deletion/renaming and binary Blueprint/assets are not supported; describe those recommendations in the ordinary review response. Symlinks, junctions, hard links and `.git` targets are rejected. Large/binary/invalid-UTF-8 files are rejected. Remote/virtual workspace behavior and every OS version have not been certified by the Windows validation run.

The declared minimum VS Code API is 1.100.0; actual editor integration validation uses the version recorded in `docs/VALIDATION.md`. Proposal JSONs contain original and proposed source text; keep them in appropriate local artifacts and follow your repository's data handling conventions. Review decisions resume only for the same proposal contents and workspace.

## Try the example without an AI service

From a source checkout after `npm ci` and `npm run compile`:

```sh
node tools/create-proposal.cjs --workspace examples/workspace --plan examples/plan.json --output examples/review-proposal.json
```

Open `examples/workspace` in VS Code and import the generated JSON. It proposes extracting a pure calculation from formatting. The generator refuses to overwrite an existing output; use another output name for a fresh run.

## Proposal format and development

See [the companion skill](agent-skill/SKILL.md) for the plan format and [proposal.schema.json](proposal.schema.json) for the generated format. The generator captures originals/hashes from disk so an agent does not have to invent them.

```sh
npm ci
npm test
npm run test:integration
npm run package
```

Development requires Node.js 22+; packaging uses the official VS Code `vsce` tool. Integration tests launch a separate VS Code instance with disposable workspace/profile directories. Set `VSCODE_EXECUTABLE_PATH` to use an installed editor instead of downloading one. Press F5 to launch the extension development host interactively.

Consequential API references used: [Tree views](https://code.visualstudio.com/api/extension-guides/tree-view), [virtual documents](https://code.visualstudio.com/api/extension-guides/virtual-documents), [diff commands](https://code.visualstudio.com/api/references/commands), [WorkspaceEdit/applyEdit](https://code.visualstudio.com/api/references/vscode-api#workspace.applyEdit), and [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust). The version-matched API declaration comments were also inspected for all-or-nothing text edits and document versions.
