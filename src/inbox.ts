/** Completed agent reviews travel through a local, non-executing workspace inbox. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_BUNDLE_BYTES, parseProposal, Proposal, readUtf8, sha256 } from './core';

export const INBOX = '.review-proposals/inbox';
export interface PublishedReview { source: string; root: string; proposal: Proposal; signature: string }

function inboxDirectory(root: string, create: boolean): string | undefined {
  let directory = fs.realpathSync(root);
  for (const part of INBOX.split('/')) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) {
      if (!create) return undefined;
      fs.mkdirSync(directory);
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Review inbox must be a real directory inside the workspace.');
  }
  return directory;
}

/** Rename a fully written temporary file; watchers never consume half-written JSON. */
export function publishProposal(root: string, proposal: Proposal): string {
  const content = JSON.stringify(parseProposal(JSON.stringify(proposal)), null, 2) + '\n';
  const directory = inboxDirectory(root, true)!;
  const filename = `${Date.now()}-${randomUUID()}.json`;
  const output = path.join(directory, filename), temporary = output + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, output);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return output;
}

/** Only completed, bounded regular files are candidates; an invalid newest file cannot hide older valid reviews. */
export function newestPublishedReview(roots: string[]): { review?: PublishedReview; issues: string[] } {
  const candidates: { source: string; root: string; modified: number }[] = [], issues: string[] = [];
  for (const root of roots) {
    try {
      const directory = inboxDirectory(root, false);
      if (!directory) continue;
      const names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
      if (names.length > 1000) throw new Error('Review inbox exceeds 1,000 files; archive older review files before scanning.');
      for (const name of names) {
        const source = path.join(directory, name), stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BUNDLE_BYTES) {
          issues.push(`Skipped unsupported review file: ${source}`); continue;
        }
        candidates.push({ source, root, modified: stat.mtimeMs });
      }
    } catch (error) { issues.push(`${root}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  candidates.sort((a, b) => b.modified - a.modified || b.source.localeCompare(a.source));
  for (const candidate of candidates) {
    try {
      const content = readUtf8(candidate.source, MAX_BUNDLE_BYTES);
      return { review: { ...candidate, proposal: parseProposal(content), signature: sha256(candidate.root + '\n' + content) }, issues };
    } catch (error) { issues.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { issues };
}
