import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileIdentity, normalizeText, sha256 } from '../core';
import type { ReviewApi } from '../extension';
import { publishProposal } from '../inbox';
import { parseProposal } from '../core';

export async function run(): Promise<void> {
  const temporary = process.env.REVIEW_PROPOSALS_TEST_ROOT!;
  const home = process.env.REVIEW_PROPOSALS_TEST_HOME!;
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  assert.ok(root && fileIdentity(root).startsWith(fileIdentity(temporary) + path.sep));
  assert.equal(fileIdentity(os.homedir()), fileIdentity(home), 'Companion skill tests must use the disposable home, never the real profile.');
  const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'review-proposals');
  assert.ok(extension, 'Extension is registered');
  const api = await extension.activate() as ReviewApi;
  let passed = 0;
  const originalA = 'export const a = 1;\n', originalB = 'export const b = 2;\n';
  const aPath = path.join(root, 'alpha.ts'), bPath = path.join(root, 'beta.ts');
  fs.writeFileSync(aPath, originalA); fs.writeFileSync(bPath, originalB);
  const a = await vscode.workspace.openTextDocument(vscode.Uri.file(aPath));
  const b = await vscode.workspace.openTextDocument(vscode.Uri.file(bPath));

  async function importReview(id: string, both = true): Promise<string> {
    const files = [{ path: 'alpha.ts', before: originalA, after: 'export const a = 3;\n', baseSha256: sha256(originalA) }];
    if (both) files.push({ path: 'beta.ts', before: originalB, after: 'export const b = 4;\n', baseSha256: sha256(originalB) });
    const proposal = { schemaVersion: 1, id, title: 'Editor integration review', groups: [{
      id: 'group', title: 'Separate calculation from presentation', kind: 'refactor', priority: 'medium',
      reason: 'Exercise a grouped proposal in the real editor.', benefit: 'Coherent test boundaries.', tradeoffs: 'Preserve callers.',
      documentation: [], checks: [{ description: 'Example check', status: 'not-run' }], files
    }] };
    const file = path.join(temporary, id + '.json'); fs.writeFileSync(file, JSON.stringify(proposal));
    await api.importFile(file, root!); return file;
  }
  async function reset(): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const [doc, text] of [[a, originalA], [b, originalB]] as const) edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await a.save(); await b.save(); await api.clear();
  }
  async function until(condition: () => boolean): Promise<void> {
    const end = Date.now() + 8000;
    while (!condition()) {
      assert.ok(Date.now() < end, 'Timed out waiting for the observed editor state');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try {
    await importReview('preview');
    await api.preview('group', 'alpha.ts');
    assert.ok(vscode.workspace.textDocuments.some(document => document.uri.scheme === 'review-proposal' && document.getText() === 'export const a = 3;\n'));
    assert.equal(a.getText(), originalA); assert.equal(b.getText(), originalB);
    assert.equal(fs.readFileSync(aPath, 'utf8'), originalA); assert.equal(a.isDirty, false);
    console.log('PASS: real virtual diff previews leave project buffers and disk unchanged.'); passed++;

    await api.reject('group');
    assert.equal(api.session()?.status('group').state, 'rejected');
    assert.equal(a.getText(), originalA);
    console.log('PASS: reject does not modify files.'); passed++;

    await api.importFile(path.join(temporary, 'preview.json'), root);
    assert.equal(api.session()?.status('group').state, 'rejected');
    console.log('PASS: reimporting the same immutable proposal restores its decision.'); passed++;

    await importReview('accept'); await api.accept('group');
    assert.equal(normalizeText(a.getText()), 'export const a = 3;\n');
    assert.equal(normalizeText(b.getText()), 'export const b = 4;\n');
    assert.equal(a.isDirty, true); assert.equal(b.isDirty, true);
    assert.equal(fs.readFileSync(aPath, 'utf8'), originalA);
    assert.equal(fs.readFileSync(bPath, 'utf8'), originalB);
    assert.equal(api.session()?.status('group').state, 'accepted');
    console.log('PASS: grouped text edits update both real editor buffers without forced save.'); passed++;

    await reset(); await importReview('undo', false);
    await vscode.window.showTextDocument(a); await api.accept('group');
    await vscode.commands.executeCommand('undo');
    assert.equal(normalizeText(a.getText()), originalA);
    console.log('PASS: native Undo restores an accepted text edit.'); passed++;

    await reset(); await importReview('dirty');
    const editor = await vscode.window.showTextDocument(b);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// unsaved user work\n'));
    await assert.rejects(api.accept('group'), /editor contents/);
    assert.equal(a.getText(), originalA);
    assert.ok(b.getText().startsWith('// unsaved user work'));
    console.log('PASS: unsaved work blocks the whole group and remains intact.'); passed++;

    await reset(); await importReview('disk');
    fs.writeFileSync(bPath, 'external disk edit\n');
    await assert.rejects(api.accept('group'), /changed on disk/);
    assert.equal(a.getText(), originalA);
    console.log('PASS: a changed disk target blocks every edit in the group.'); passed++;
    fs.writeFileSync(bPath, originalB);

    await reset(); await importReview('cleanup', false);
    await vscode.workspace.getConfiguration('reviewProposals').update('acceptedCleanupDelay', 0.15, vscode.ConfigurationTarget.Global);
    await api.accept('group');
    assert.deepEqual(api.visibleGroups(), ['group']);
    await until(() => api.visibleGroups().length === 0);
    assert.equal(api.session()?.savedDecisions().group, 'accepted');
    assert.equal(normalizeText(a.getText()), 'export const a = 3;\n');
    assert.equal(fs.readFileSync(aPath, 'utf8'), originalA);
    await vscode.commands.executeCommand('reviewProposals.showAccepted');
    assert.deepEqual(api.visibleGroups(), ['group']);
    await api.importFile(path.join(temporary, 'cleanup.json'), root);
    assert.deepEqual(api.visibleGroups(), [], 'Restored accepted time must not restart the cleanup countdown');
    console.log('PASS: accepted cleanup hides only sidebar items, preserves decisions/edits and supports showing them again.'); passed++;

    await vscode.workspace.getConfiguration('reviewProposals').update('acceptedCleanupDelay', 0, vscode.ConfigurationTarget.Global);
    assert.deepEqual(api.visibleGroups(), ['group']);
    console.log('PASS: a zero cleanup delay keeps accepted recommendations visible.'); passed++;

    await reset();
    const raw = JSON.parse(fs.readFileSync(path.join(temporary, 'cleanup.json'), 'utf8'));
    raw.id = 'watched-publication'; raw.title = 'Automatically loaded review';
    publishProposal(root, parseProposal(JSON.stringify(raw)));
    await until(() => api.session()?.proposal.id === 'watched-publication');
    assert.equal(a.getText(), originalA); assert.equal(a.isDirty, false);
    assert.deepEqual(api.visibleGroups(), ['group']);
    console.log('PASS: publishing through the inbox triggers the real watcher and loads recommendations without file selection or code edits.'); passed++;

    await api.clear();
    await vscode.commands.executeCommand('reviewProposals.loadLatest');
    await until(() => api.session()?.proposal.id === 'watched-publication');
    console.log('PASS: Show Latest Review restores the published review without opening a file picker.'); passed++;

    await vscode.commands.executeCommand('reviewProposals.scm.focus');
    await vscode.commands.executeCommand('reviewProposals.reject', { groupId: 'group', sessionKey: api.session()!.fingerprint });
    await vscode.commands.executeCommand('reviewProposals.pending.focus');
    assert.equal(api.session()?.savedDecisions().group, 'rejected');
    assert.equal(a.getText(), originalA);
    console.log('PASS: Source Control and dedicated review views use the same decisions without changing source.'); passed++;

    await vscode.commands.executeCommand('reviewProposals.installSkill');
    for (const agent of ['.claude', '.agents']) {
      const skill = path.join(home, agent, 'skills/propose-code-review');
      for (const file of ['SKILL.md', 'scripts/core.js', 'scripts/inbox.js', 'scripts/create-proposal.cjs', 'proposal.schema.json']) assert.ok(fs.existsSync(path.join(skill, file)));
      const replacement = path.join(temporary, 'replacement.ts'); fs.writeFileSync(replacement, 'export const a = 9;\n');
      const plan = { id: 'installed-' + agent, title: 'Installed helper review', groups: [{
        id: 'helper', title: 'A helper proposal', kind: 'refactor', priority: 'low', reason: 'Test the self-contained installed generator.',
        documentation: [], checks: [], files: [{ path: 'alpha.ts', proposedFile: replacement }]
      }] };
      const planPath = path.join(temporary, 'plan-' + agent + '.json'), output = path.join(temporary, 'proposal-' + agent + '.json');
      fs.writeFileSync(planPath, JSON.stringify(plan));
      // Electron's executable is not a standalone Node CLI; use the runner's Node path.
      execFileSync(process.env.REVIEW_PROPOSALS_NODE!, [path.join(skill, 'scripts/create-proposal.cjs'), '--workspace', root, '--plan', planPath, '--output', output]);
      assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).groups[0].files[0].baseSha256, sha256(originalA));
      execFileSync(process.env.REVIEW_PROPOSALS_NODE!, [path.join(skill, 'scripts/create-proposal.cjs'), '--workspace', root, '--plan', planPath, '--publish']);
      await until(() => api.session()?.proposal.id === plan.id);
    }
    console.log('PASS: the companion skill installs and its standalone generator runs for both agents.'); passed++;
    console.log(`REVIEW_PROPOSALS_INTEGRATION: ${passed} checks passed; VS Code ${vscode.version}.`);
  } finally {
    await api.clear();
    // These are disposable test files. Revert dirty buffers before closing so a
    // failed assertion cannot leave an interactive save dialog in the harness.
    for (const document of [a, b]) if (document.isDirty) { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert'); }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
