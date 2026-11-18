import * as vscode from 'vscode';
import { fileIdentity, PlannedEdit, WorkspacePort } from './core';
function documentFor(absolutePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && fileIdentity(document.uri.fsPath) === fileIdentity(absolutePath));
}

export const editorPort: WorkspacePort = {
  async open(absolutePath) { await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath)); },
  current(absolutePath) {
    const document = documentFor(absolutePath);
    return document ? { text: document.getText(), version: document.version } : undefined;
  },
  apply(edits: PlannedEdit[]) {
    const edit = new vscode.WorkspaceEdit();
    for (const proposed of edits) {
      const document = documentFor(proposed.absolutePath);
      if (!document || document.version !== proposed.version) return Promise.resolve(false);
      const replacement = document.eol === vscode.EndOfLine.CRLF ? proposed.after.replace(/\n/g, '\r\n') : proposed.after;
      edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), replacement);
    }
    // VS Code applies text-only WorkspaceEdits all-or-nothing. No save or shell execution follows.
    return Promise.resolve(vscode.workspace.applyEdit(edit));
  }
};
