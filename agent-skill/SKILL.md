---
name: propose-code-review
description: "Export grouped, previewable code-review recommendations for the Review Proposals VS Code extension without editing target source files. Use when the user requests proposed changes with Accept/Reject review; exclude ordinary direct implementation and automatic application."
---

# Propose Code Review

Review the requested scope using the user's requirements, existing architecture/reuse candidates, matching maintainer documentation, and relevant baseline evidence. Use `review-and-repair-code` when available, including its separation of confirmed defects from optional maintainability/efficiency recommendations. This skill exports proposed edits; it does not authorize applying them.

## Preserve the working project

Do not modify target source files to prepare a preview. Save full proposed replacement contents in a separate temporary/artifact directory. Preserve existing working changes and inspect unsaved/editor state where available. The helper captures current disk contents; if the editor has different unsaved contents, the extension marks the proposal stale instead of overwriting them.

Give each recommendation an independent purpose and group every required dependent edit together. An extraction and its caller updates belong to one group. Do not split a transaction or submit half a refactor. Search compatible existing behavior before suggesting a new helper. Mark performance reasoning as measured evidence, a code-supported opportunity, or an untested hypothesis; never invent benchmark results. Prefer a few concrete useful changes over a cleanup quota.

Version 0.1 supports replacements of existing UTF-8 text files within one workspace. File creation/deletion/renaming, symlink/junction/hard-link targets, binary Unreal assets, and automatic code/test execution are outside this format. Keep those as clearly explained recommendations instead of fabricating an applicable patch. Changes inside .git are rejected. Unsupported recommendations can be reported in the agent's normal review response.

## Write the plan and generate a proposal

The extension's **Install Companion Skill** command installs this file plus `scripts/create-proposal.cjs`, `scripts/core.js`, and `proposal.schema.json`. Node.js 22+ is needed to run the generator. In an extension checkout, run `npm ci` and `npm run compile`, then use `tools/create-proposal.cjs` instead. Resolve the helper from its actual location, not from the project being reviewed.

Plan format (replacement paths are relative to the plan file; target paths are workspace-relative with forward slashes):

```json
{
  "id": "review-unique-id",
  "title": "Focused review",
  "groups": [{
    "id": "extract-total",
    "title": "Separate calculation from formatting",
    "kind": "refactor",
    "priority": "medium",
    "reason": "Explain the concrete responsibility or correctness issue.",
    "benefit": "Explain the useful boundary or observed benefit.",
    "tradeoffs": "Explain compatibility, complexity and verification costs.",
    "documentation": [],
    "checks": [{ "description": "Relevant regression check", "status": "not-run" }],
    "files": [{ "path": "src/total.ts", "proposedFile": "replacement-total.ts" }]
  }]
}
```

`kind` is `bug`, `refactor`, or `optimization`. `priority` is `high`, `medium`, or `low`; priority does not itself establish a blocking defect. Documentation items contain `title` and an HTTPS `url` actually supporting the recommendation. Check items contain `description`, `status` (`passed`, `failed`, or `not-run`), and optional `detail`. Report only checks actually executed as passed. The extension labels these as agent-reported evidence.

Run the generator with paths quoted for the current shell:

```text
node "SKILL_DIR/scripts/create-proposal.cjs" --workspace "PROJECT_ROOT" --plan "TEMP_DIR/plan.json" --output "TEMP_DIR/review-proposal.json"
```

The helper reads originals, normalizes UTF-8 BOM/CRLF for comparison, computes hashes, validates the grouped result, and exclusively creates a new output file. It does not edit target files or overwrite an existing output. Choose a fresh proposal filename when regenerating. Do not hand-invent original contents or hashes to bypass staleness checks.

Return the proposal path, concise findings/recommendations and actual verification gaps. The user imports it with **Review Proposals: Import Proposal**. Accept/Reject belongs to the user; do not invoke acceptance commands or modify files after producing a proposal unless separately authorized. When the source changes, regenerate from current evidence rather than silently rebasing a reviewed change.
