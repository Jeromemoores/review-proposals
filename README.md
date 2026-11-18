# Review Proposals

A VS Code companion for reviewing agent recommendations **before applying code changes**. Import a proposal, inspect the current-versus-proposed diff, read the explanation and evidence, then accept or reject each recommendation.

Works with proposals from Claude Code, Codex, or another agent using the same format. No model account, API key, server, or automatic repository upload is required by this extension. It complements the [Web and Unreal development skills](https://github.com/Jeromemoores/skills).

## Install

1. Download **review-proposals-0.2.0.vsix** from [Releases](https://github.com/Jeromemoores/review-proposals/releases/latest).
2. In VS Code, run **Extensions: Install from VSIX…** from the Command Palette and select it. Alternatively:

```sh
code --install-extension review-proposals-0.2.0.vsix
```

Open a project folder, then select **Review Proposals** in the activity bar. This package is distributed as a VSIX; it is not currently published in the Visual Studio Marketplace.

## Open reviews with one click

Click **Review Proposals** in the activity bar, or open **Source Control** and expand **Proposed**. The latest completed agent review loads automatically. New publications appear while the extension is active; no JSON file selection is needed. Both views share one review and one set of decisions.

The workflow is **Proposed → accept and save → Git Changes → stage → Staged Changes → commit**. Proposed is a separate Source Control section, using VS Code's supported view API; it does not modify Git's provider or index. In a Git repository, saved accepted edits appear in Git's normal Changes list. You control staging and commits.

Your existing coding agent performs the analysis and publishes results:

1. Run **Review Proposals: Install Companion Skill for Claude Code and Codex** once to install/update the `propose-code-review` instructions and self-contained helper.
2. Use **Copy Agent Review Instructions** with the review scope. Updated agents publish directly to the open workspace's local review inbox.
3. Open either review view, click a recommendation/file to see its diff, and use **Show Recommendation Details** for reasons, tradeoffs, documentation and reported checks.
4. Choose **Accept Recommendation** or **Reject Recommendation**. Acceptance applies dependent edits together to editor buffers. Save, run appropriate checks, then stage/commit using your normal Git workflow.

**Accepted recommendations hide from both sidebars after 10 seconds.** The decision and editor changes remain intact. Use **Show/Hide Accepted Recommendations** in the view's menu to revisit them. `reviewProposals.acceptedCleanupDelay` changes the delay in seconds; `0` keeps accepted items visible. Cleanup does not delete source/proposal files, save buffers, undo changes, stage or commit code.

Auto-import reads completed `.review-proposals/inbox/*.json` publications under the owning open workspace root. The helper writes atomically so a partial result cannot replace a review. Multiple open roots keep their owning workspace association. Invalid results are skipped and logged to the Review Proposals output channel; existing valid reviews remain usable. Keep the local inbox out of version control: proposals contain original and proposed source text. `reviewProposals.autoImport` can disable automatic discovery; **Show Latest Review** provides an explicit scan. **Import Proposal** remains available for older standalone exports.

The extension uses your agent's output and requires no model API key, server or repo upload. Node.js 22+ is required for the generator; the installed extension uses VS Code's runtime. Examples: ?Review the reservation retry flow and publish grouped proposals without changing source.? Or: ?Review this Unreal C++ system for lifecycle defects and useful function boundaries; publish recommendations.?

## What the controls mean

| State | Meaning |
| --- | --- |
| Pending | Original disk/editor contents still match; the recommendation can be accepted. |
| Stale | A target changed, is unavailable, or is unsupported. Regenerate the proposal; acceptance is blocked. |
| Accepted | The grouped edit was accepted into editor buffers. This does not mean tests passed, files were committed, or runtime behavior was verified. |
| Rejected | The recommendation was dismissed without editing targets. |

Preview uses read-only virtual snapshots, not temporary edits to source files. Acceptance rechecks every target, including unsaved editor contents, immediately before submitting one text-only WorkspaceEdit. VS Code documents text-only edits as all-or-nothing. If two recommendations touch the same file, accepting one can make the other stale; v0.2 does not silently merge/rebase it. Use **Refresh Status** after external file changes; the final acceptance check always revalidates contents.

The extension does not execute agents, tests, shell commands, links, or code from proposals. Documentation URLs and test results are **agent supplied** and are not independently verified by the extension. It has no telemetry or network client. Installing the companion skill writes only its managed skill directories. Applying edits and installing the skill require Workspace Trust.

## First-version scope

Version 0.2 applies replacements to **existing UTF-8 text files within one filesystem workspace**. It supports web code, Unreal C++/headers, build/configuration files and other text. File creation/deletion/renaming and binary Blueprint/assets are not supported; describe those recommendations in the ordinary review response. Symlinks, junctions, hard links and `.git` targets are rejected. Large/binary/invalid-UTF-8 files are rejected. Remote/virtual workspace behavior and every OS version have not been certified by the Windows validation run.

The declared minimum VS Code API is 1.100.0; actual editor integration validation uses the version recorded in `docs/VALIDATION.md`. Proposal JSONs contain original and proposed source text; keep them in appropriate local artifacts and follow your repository's data handling conventions. Review decisions resume only for the same proposal contents and workspace.

## Try the example without an AI service

From a source checkout after `npm ci` and `npm run compile`:

```sh
node tools/create-proposal.cjs --workspace examples/workspace --plan examples/plan.json --publish
```

Open `examples/workspace` in VS Code and click Review Proposals (or Source Control). The published review appears automatically. It proposes extracting a pure calculation from formatting. Publishing creates a unique completed review. Explicit `--output NEW-FILE.json` exports remain exclusive and refuse overwrites.

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
