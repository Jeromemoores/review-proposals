import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileIdentity, MAX_BUNDLE_BYTES, parseProposal, readUtf8, ReviewSession, Decision } from './core';
import { PreviewDocuments, ReviewNode, ReviewTree } from './view';
import { editorPort } from './vscode-port';
import { installCompanionSkill } from './install-skill';
import { INBOX, newestPublishedReview } from './inbox';

interface Remembered { source: string; root: string; fingerprint: string; decisions: Record<string, Decision>; acceptedAt?: Record<string, number> }
export interface ReviewApi {
  importFile(source: string, root: string): Promise<void>;
  session(): ReviewSession | undefined;
  preview(groupId: string, filePath: string): Promise<void>;
  accept(groupId: string): Promise<void>;
  reject(groupId: string): Promise<void>;
  clear(): Promise<void>;
  loadLatest(): Promise<void>;
  visibleGroups(): string[];
}

export function activate(context: vscode.ExtensionContext): ReviewApi {
  let active: ReviewSession | undefined;
  let sourcePath: string | undefined;
  let persistence: Promise<void> = Promise.resolve();
  let acceptedAt: Record<string, number> = {};
  let showAccepted = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoLoading = false, disposed = false;
  let lastAutoSignature: string | undefined;
  const output = vscode.window.createOutputChannel('Review Proposals');
  const tree = new ReviewTree(() => active, hidden);
  const previews = new PreviewDocuments();
  const view = vscode.window.createTreeView('reviewProposals.pending', { treeDataProvider: tree, showCollapseAll: true });
  const scmView = vscode.window.createTreeView('reviewProposals.scm', { treeDataProvider: tree, showCollapseAll: true });
  const views = [view, scmView];
  context.subscriptions.push(tree, previews, ...views, output, vscode.workspace.registerTextDocumentContentProvider('review-proposal', previews), {
    dispose() { disposed = true; if (cleanupTimer) clearTimeout(cleanupTimer); if (autoTimer) clearTimeout(autoTimer); }
  });

  function cleanupDelay(): number {
    const delay = vscode.workspace.getConfiguration('reviewProposals').get<number>('acceptedCleanupDelay', 10);
    return Number.isFinite(delay) && delay >= 0 && delay <= 3600 ? delay : 10;
  }
  function hidden(id: string): boolean {
    const delay = cleanupDelay();
    return !showAccepted && delay > 0 && active?.savedDecisions()[id] === 'accepted'
      && Number.isFinite(acceptedAt[id]) && Date.now() - acceptedAt[id] >= delay * 1000;
  }
  function scheduleCleanup(): void {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    const delay = cleanupDelay();
    if (disposed || showAccepted || !delay) return;
    const remaining = Object.values(acceptedAt).map(at => delay * 1000 - (Date.now() - at)).filter(ms => ms > 0);
    if (remaining.length) cleanupTimer = setTimeout(refresh, Math.min(...remaining) + 5);
  }

  function rootIsOpen(root: string): boolean {
    return !!vscode.workspace.workspaceFolders?.some(folder => {
      if (folder.uri.scheme !== 'file') return false;
      try { return fileIdentity(fs.realpathSync(folder.uri.fsPath)) === fileIdentity(fs.realpathSync(root)); } catch { return false; }
    });
  }
  async function remember(): Promise<void> {
    const snapshot: Remembered | undefined = active && sourcePath ? {
        source: sourcePath, root: active.root, fingerprint: active.fingerprint, decisions: active.savedDecisions(), acceptedAt: { ...acceptedAt }
    } : undefined;
    // Preserve invocation order even if the underlying storage completes asynchronously.
    persistence = persistence.catch(() => {}).then(() => context.workspaceState.update('reviewProposals.lastReview', snapshot));
    await persistence;
  }
  function refresh(): void {
    tree.refresh();
    for (const targetView of views) {
      targetView.title = targetView === scmView ? 'Proposed' : active ? active.proposal.title : 'Review Proposals';
      targetView.description = active ? `${tree.getChildren().length} recommendation(s)` : undefined;
      targetView.message = active && tree.getChildren().length === 0 ? 'Accepted recommendations are hidden. Use Show/Hide Accepted to revisit them.' : undefined;
    }
    void vscode.commands.executeCommand('setContext', 'reviewProposals.hasReview', !!active);
    scheduleCleanup();
  }
  async function importFile(source: string, root: string): Promise<void> {
    if (active?.busy) throw new Error('Wait for the current acceptance to finish before importing another review.');
    if (!rootIsOpen(root)) throw new Error('Choose an open filesystem workspace folder for this proposal.');
    const proposal = parseProposal(readUtf8(source, MAX_BUNDLE_BYTES));
    const next = new ReviewSession(root, proposal);
    const previous = context.workspaceState.get<Remembered>('reviewProposals.lastReview');
    if (previous?.fingerprint === next.fingerprint && fileIdentity(previous.root) === fileIdentity(next.root)) {
      active = new ReviewSession(root, proposal, previous.decisions);
      acceptedAt = Object.fromEntries(Object.entries(previous.acceptedAt ?? {}).filter(([, at]) => Number.isFinite(at) && at > 0));
      for (const [id, decision] of Object.entries(active.savedDecisions())) if (decision === 'accepted' && !acceptedAt[id]) acceptedAt[id] = Date.now();
    } else { active = next; acceptedAt = {}; }
    showAccepted = false;
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
    try { await session.accept(groupId, editorPort); acceptedAt[groupId] = Date.now(); await remember(); }
    finally { refresh(); }
    void vscode.window.showInformationMessage(`Accepted “${session.group(groupId).title}” into editor buffers. Review, save and run checks when ready.`);
  }
  async function reject(groupId: string): Promise<void> {
    requireSession().reject(groupId); await remember(); refresh();
  }
  async function clear(): Promise<void> {
    if (active?.busy) throw new Error('Wait for the current acceptance to finish.');
    active = undefined; sourcePath = undefined; acceptedAt = {}; showAccepted = false; previews.clear(); refresh(); await remember();
  }
  function queueAutoImport(): void {
    if (disposed || !vscode.workspace.getConfiguration('reviewProposals').get<boolean>('autoImport', true)) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { void loadLatest(); }, 200);
  }
  async function loadLatest(): Promise<void> {
    if (disposed) return;
    if (autoLoading || active?.busy) { queueAutoImport(); return; }
    autoLoading = true;
    try {
      const roots = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) ?? [];
      const { review, issues } = newestPublishedReview(roots);
      for (const issue of issues) output.appendLine(issue);
      if (!review || (active && review.signature === lastAutoSignature)) return;
      await importFile(review.source, review.root);
      lastAutoSignature = review.signature;
      const first = tree.getChildren()[0];
      for (const targetView of views) if (targetView.visible && first) await targetView.reveal(first, { focus: false, select: false });
    } catch (error) { output.appendLine(error instanceof Error ? error.message : String(error)); }
    finally { autoLoading = false; }
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
    if (files?.[0]) { await importFile(files[0].fsPath, folder.uri.fsPath); const first = tree.getChildren()[0]; if (first) await view.reveal(first, { focus: true }); }
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
  command('refresh', async () => { await loadLatest(); refresh(); });
  command('loadLatest', loadLatest);
  command('showAccepted', async () => { showAccepted = !showAccepted; refresh(); });
  command('clear', clear);
  command('copyInstructions', async () => {
    const helper = context.asAbsolutePath('tools/create-proposal.cjs');
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
    const workspace = folders.length === 1 ? JSON.stringify(folders[0].uri.fsPath) : 'ROOT';
    const instructions = `Use review-and-repair-code to review the requested scope. Use propose-code-review if installed. Produce grouped recommendations with concrete reasons, documentation, tradeoffs and honest check results. Do not edit the target project files. Save proposed replacement files and a plan JSON outside the source tree, then run the proposal generator at ${JSON.stringify(helper)} with --workspace ${workspace} --plan PLAN.json --publish. ROOT must be the owning folder open in VS Code, not a nested package. Quote paths for the actual shell. Group dependent edits together; targets must be existing UTF-8 text files. The generator captures originals/hashes and atomically publishes to the local review inbox. Open Review Proposals or Source Control's Proposed section to see recommendations automatically; no manual import is needed. Format instructions: ${context.asAbsolutePath('agent-skill/SKILL.md')}`;
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
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${INBOX}/*.json`);
  context.subscriptions.push(watcher, watcher.onDidCreate(queueAutoImport), watcher.onDidChange(queueAutoImport), watcher.onDidDelete(queueAutoImport),
    ...views.map(targetView => targetView.onDidChangeVisibility(event => { if (event.visible) queueAutoImport(); })),
    vscode.workspace.onDidChangeWorkspaceFolders(queueAutoImport),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('reviewProposals')) { refresh(); queueAutoImport(); } }));
  const last = context.workspaceState.get<Remembered>('reviewProposals.lastReview');
  if (last && rootIsOpen(last.root)) void importFile(last.source, last.root).catch(() => { refresh(); }).finally(queueAutoImport);
  else { refresh(); queueAutoImport(); }
  return { importFile, session: () => active, preview, accept, reject, clear, loadLatest, visibleGroups: () => tree.getChildren().map(node => node.groupId) };
}
