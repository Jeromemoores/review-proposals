import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileIdentity, MAX_BUNDLE_BYTES, parseProposal, readUtf8, ReviewSession, Decision } from './core';
import { PreviewDocuments, ReviewNode, ReviewTree } from './view';
import { editorPort } from './vscode-port';
import { installCompanionSkill } from './install-skill';

interface Remembered { source: string; root: string; fingerprint: string; decisions: Record<string, Decision> }
export interface ReviewApi {
  importFile(source: string, root: string): Promise<void>;
  session(): ReviewSession | undefined;
  preview(groupId: string, filePath: string): Promise<void>;
  accept(groupId: string): Promise<void>;
  reject(groupId: string): Promise<void>;
  clear(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ReviewApi {
  let active: ReviewSession | undefined;
  let sourcePath: string | undefined;
  let persistence: Promise<void> = Promise.resolve();
  const tree = new ReviewTree(() => active);
  const previews = new PreviewDocuments();
  const view = vscode.window.createTreeView('reviewProposals.pending', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(tree, previews, view, vscode.workspace.registerTextDocumentContentProvider('review-proposal', previews));

  function rootIsOpen(root: string): boolean {
    return !!vscode.workspace.workspaceFolders?.some(folder => {
      if (folder.uri.scheme !== 'file') return false;
      try { return fileIdentity(fs.realpathSync(folder.uri.fsPath)) === fileIdentity(fs.realpathSync(root)); } catch { return false; }
    });
  }
  async function remember(): Promise<void> {
    const snapshot: Remembered | undefined = active && sourcePath ? {
        source: sourcePath, root: active.root, fingerprint: active.fingerprint, decisions: active.savedDecisions()
    } : undefined;
    // Preserve invocation order even if the underlying storage completes asynchronously.
    persistence = persistence.catch(() => {}).then(() => context.workspaceState.update('reviewProposals.lastReview', snapshot));
    await persistence;
  }
  function refresh(): void {
    tree.refresh();
    view.title = active ? active.proposal.title : 'Recommendations';
    view.description = active ? `${active.proposal.groups.length} recommendation(s)` : undefined;
    void vscode.commands.executeCommand('setContext', 'reviewProposals.hasReview', !!active);
  }
  async function importFile(source: string, root: string): Promise<void> {
    if (active?.busy) throw new Error('Wait for the current acceptance to finish before importing another review.');
    if (!rootIsOpen(root)) throw new Error('Choose an open filesystem workspace folder for this proposal.');
    const proposal = parseProposal(readUtf8(source, MAX_BUNDLE_BYTES));
    const next = new ReviewSession(root, proposal);
    const previous = context.workspaceState.get<Remembered>('reviewProposals.lastReview');
    if (previous?.fingerprint === next.fingerprint && fileIdentity(previous.root) === fileIdentity(next.root)) {
      active = new ReviewSession(root, proposal, previous.decisions);
    } else active = next;
    sourcePath = path.resolve(source);
    previews.clear(); refresh(); await remember();
  }
  function requireSession(): ReviewSession {
    if (!active) throw new Error('Import a proposal first.');
    if (!rootIsOpen(active.root)) throw new Error('The proposal workspace is no longer open.');
    return active;
  }
  async function preview(groupId: string, filePath: string): Promise<void> {
    const session = requireSession();
    await previews.show(session, { groupId, filePath, sessionKey: session.fingerprint });
  }
  async function accept(groupId: string): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before applying changes.');
    const session = requireSession();
    try { await session.accept(groupId, editorPort); await remember(); }
    finally { refresh(); }
    void vscode.window.showInformationMessage(`Accepted “${session.group(groupId).title}” into editor buffers. Review, save and run checks when ready.`);
  }
  async function reject(groupId: string): Promise<void> {
    requireSession().reject(groupId); await remember(); refresh();
  }
  async function clear(): Promise<void> {
    if (active?.busy) throw new Error('Wait for the current acceptance to finish.');
    active = undefined; sourcePath = undefined; previews.clear(); refresh(); await remember();
  }
  async function chooseNode(argument?: unknown): Promise<ReviewNode | undefined> {
    const session = requireSession();
    const supplied = argument && typeof argument === 'object' ? argument as Partial<ReviewNode> : undefined;
    const fromEditor = vscode.window.activeTextEditor && previews.node(vscode.window.activeTextEditor.document.uri);
    const node = supplied?.groupId ? supplied : fromEditor;
    if (node?.groupId) {
      if (node.sessionKey !== session.fingerprint) throw new Error('This action belongs to a previous review. Open the current recommendation.');
      session.group(node.groupId);
      return { ...node } as ReviewNode;
    }
    const choice = await vscode.window.showQuickPick(session.proposal.groups.map(group => ({ label: group.title, description: session.status(group.id, editorPort).state, groupId: group.id })), { title: 'Choose a recommendation' });
    return choice && { groupId: choice.groupId, sessionKey: session.fingerprint };
  }
  function command(name: string, action: (...args: unknown[]) => Promise<unknown>): void {
    context.subscriptions.push(vscode.commands.registerCommand('reviewProposals.' + name, async (...args) => {
      try { return await action(...args); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }));
  }
  command('import', async () => {
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
    if (!folders.length) throw new Error('Open a filesystem workspace folder first.');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { title: 'Which workspace owns this proposal?' }).then(item => item?.folder);
    if (!folder) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Review proposal': ['json'] }, defaultUri: folder.uri });
    if (files?.[0]) { await importFile(files[0].fsPath, folder.uri.fsPath); await view.reveal(tree.getChildren()[0], { focus: true }); }
  });
  command('preview', async argument => {
    const node = await chooseNode(argument);
    if (!node) return;
    if (!node.filePath) {
      const group = requireSession().group(node.groupId);
      node.filePath = group.files.length === 1 ? group.files[0].path : await vscode.window.showQuickPick(group.files.map(file => file.path), { title: `${group.title} — grouped recommendation` });
    }
    if (node.filePath) await preview(node.groupId, node.filePath);
  });
  command('details', async argument => {
    const node = await chooseNode(argument);
    if (!node) return;
    const session = requireSession(), group = session.group(node.groupId), status = session.status(group.id, editorPort);
    const content = [group.title, `${group.kind} · ${group.priority} priority · ${status.state}`, status.reason ?? '', '', 'WHY', group.reason,
      '', 'EXPECTED BENEFIT', group.benefit ?? 'Not supplied.', '', 'TRADEOFFS', group.tradeoffs ?? 'Not supplied.',
      '', 'FILES — ACCEPT APPLIES THIS GROUP TOGETHER', ...group.files.map(file => file.path),
      '', 'DOCUMENTATION (agent supplied)', ...group.documentation.map(doc => `${doc.title}\n${doc.url}`),
      '', 'CHECKS (agent reported; this extension does not execute or verify them)', ...group.checks.map(check => `[${check.status}] ${check.description}${check.detail ? '\n' + check.detail : ''}`),
      '', 'Accept applies text changes to editor buffers; normal Save/Auto Save and Undo behavior applies.'].join('\n');
    const document = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  command('accept', async argument => { const node = await chooseNode(argument); if (node) await accept(node.groupId); });
  command('reject', async argument => { const node = await chooseNode(argument); if (node) await reject(node.groupId); });
  command('refresh', async () => refresh());
  command('clear', clear);
  command('copyInstructions', async () => {
    const helper = context.asAbsolutePath('tools/create-proposal.cjs');
    const instructions = `Use review-and-repair-code to review the requested scope. Use propose-code-review if installed. Produce grouped recommendations with concrete reasons, documentation, tradeoffs and honest check results. Do not edit the target project files. Save proposed replacement files and a plan JSON outside the source tree, then run the proposal generator at ${JSON.stringify(helper)} with --workspace ROOT --plan PLAN.json --output NEW-PROPOSAL.json. Quote paths for the actual shell. Group dependent edits together; targets must be existing UTF-8 text files. The generator captures original contents and hashes. Import the generated proposal with Review Proposals: Import Proposal. Format instructions: ${context.asAbsolutePath('agent-skill/SKILL.md')}`;
    await vscode.env.clipboard.writeText(instructions);
    void vscode.window.showInformationMessage('Agent review instructions copied. Paste them into your coding agent.');
  });
  command('installSkill', async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before installing the companion skill.');
    installCompanionSkill(context.extensionPath, os.homedir(), context.extension.id, String(context.extension.packageJSON.version));
    void vscode.window.showInformationMessage('Installed propose-code-review for Claude Code and Codex. Start a new agent session if needed.');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 100); };
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(schedule), vscode.window.onDidChangeWindowState(state => { if (state.focused) schedule(); }), { dispose() { if (timer) clearTimeout(timer); } });
  const last = context.workspaceState.get<Remembered>('reviewProposals.lastReview');
  if (last && rootIsOpen(last.root)) void importFile(last.source, last.root).catch(() => { refresh(); });
  else refresh();
  return { importFile, session: () => active, preview, accept, reject, clear };
}
