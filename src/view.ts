import * as vscode from 'vscode';
import { ReviewSession, Status } from './core';
import { editorPort } from './vscode-port';

export interface ReviewNode { groupId: string; sessionKey: string; filePath?: string }

export class ReviewTree implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private statuses = new Map<string, Status>();
  constructor(private readonly session: () => ReviewSession | undefined, private readonly hidden: (id: string) => boolean = () => false) {}
  refresh(): void {
    this.statuses.clear();
    const session = this.session();
    if (session) for (const group of session.proposal.groups) this.statuses.set(group.id, session.status(group.id, editorPort));
    this.changed.fire(undefined);
  }
  getChildren(node?: ReviewNode): ReviewNode[] {
    const session = this.session();
    if (!session) return [];
    if (!node) return session.proposal.groups.filter(group => !this.hidden(group.id)).map(group => ({ groupId: group.id, sessionKey: session.fingerprint }));
    if (node.filePath || node.sessionKey !== session.fingerprint) return [];
    return session.group(node.groupId).files.map(file => ({ ...node, filePath: file.path }));
  }
  getParent(node: ReviewNode): ReviewNode | undefined {
    return node.filePath ? { groupId: node.groupId, sessionKey: node.sessionKey } : undefined;
  }
  getTreeItem(node: ReviewNode): vscode.TreeItem {
    const session = this.session();
    if (!session || node.sessionKey !== session.fingerprint) return new vscode.TreeItem('Previous review');
    const group = session.group(node.groupId);
    const status = this.statuses.get(group.id) ?? session.status(group.id, editorPort);
    if (node.filePath) {
      const item = new vscode.TreeItem(node.filePath, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'reviewFile'; item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command: 'reviewProposals.preview', title: 'Preview change', arguments: [node] };
      return item;
    }
    const item = new vscode.TreeItem(group.title, vscode.TreeItemCollapsibleState.Expanded);
    item.id = session.fingerprint + ':' + group.id;
    item.description = `${status.state} · ${group.kind} · ${group.priority}`;
    item.contextValue = `reviewGroup.${status.state}`;
    item.iconPath = new vscode.ThemeIcon(({ pending: 'lightbulb', stale: 'warning', accepted: 'check', rejected: 'close' })[status.state]);
    item.tooltip = new vscode.MarkdownString().appendText(`${group.reason}\n\n${group.files.length} file(s). ${status.reason ?? 'Choose Details for evidence and tradeoffs.'}`);
    item.command = { command: 'reviewProposals.preview', title: 'Preview recommendation', arguments: [node] };
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}

/** Read-only snapshots; no project files are used as scratch space for previews. */
export class PreviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private snapshots = new Map<string, { content: string; node: ReviewNode }>();
  provideTextDocumentContent(uri: vscode.Uri): string {
    const item = this.snapshots.get(uri.toString());
    if (!item) throw new Error('This preview expired. Open the current recommendation again.');
    return item.content;
  }
  node(uri: vscode.Uri): ReviewNode | undefined { return this.snapshots.get(uri.toString())?.node; }
  clear(): void { this.snapshots.clear(); }
  async show(session: ReviewSession, node: ReviewNode): Promise<void> {
    const group = session.group(node.groupId);
    const file = group.files.find(file => file.path === node.filePath);
    if (!file) throw new Error('No file was selected for preview.');
    const uri = (side: string) => vscode.Uri.from({ scheme: 'review-proposal', path: `/${session.fingerprint}/${encodeURIComponent(group.id)}/${side}/${file.path}` });
    const before = uri('before'), after = uri('after');
    this.snapshots.set(before.toString(), { content: file.before, node });
    this.snapshots.set(after.toString(), { content: file.after, node });
    const status = session.status(group.id, editorPort);
    await vscode.commands.executeCommand('vscode.diff', before, after, `${file.path} — ${group.title}${status.state === 'stale' ? ' [STALE]' : ''}`, { preview: true });
  }
  dispose(): void { this.clear(); }
}
