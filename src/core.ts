/** Immutable proposal contracts and application rules, independent of VS Code. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 1_000_000;
export type Kind = 'bug' | 'refactor' | 'optimization';
export type Decision = 'pending' | 'accepted' | 'rejected';
export interface Change { path: string; before: string; after: string; baseSha256: string }
export interface Check { description: string; status: 'passed' | 'failed' | 'not-run'; detail?: string }
export interface Recommendation {
  id: string; title: string; kind: Kind; priority: 'high' | 'medium' | 'low'; reason: string;
  benefit?: string; tradeoffs?: string; documentation: { title: string; url: string }[];
  checks: Check[]; files: Change[];
}
export interface Proposal { schemaVersion: 1; id: string; title: string; groups: Recommendation[]; $schema?: string }
export interface Status { state: Decision | 'stale'; reason?: string }
export interface BufferSnapshot { text: string; version: number }
export interface PlannedEdit { absolutePath: string; after: string; version: number }
export interface WorkspacePort {
  open(absolutePath: string): Promise<void>;
  current(absolutePath: string): BufferSnapshot | undefined;
  /** Apply only text edits together, without saving or executing workspace code. */
  apply(edits: PlannedEdit[]): Promise<boolean>;
}

export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}
export function sha256(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}
export function fileIdentity(file: string): string {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field ${where}.${key}.`);
}
function text(value: unknown, where: string, max = 12_000, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) {
    throw new Error(`${where} must be ${empty ? '' : 'nonempty '}text, at most ${max} characters, without NUL bytes.`);
  }
}
function choices(value: unknown, allowed: string[], where: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Invalid ${where}.`);
}
function list(value: unknown, where: string, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${where} must contain ${min}–${max} items.`);
}
export function validateRelativePath(value: unknown): asserts value is string {
  text(value, 'file path', 1024);
  const parts = value.split('/');
  if (value.includes('\\') || value.includes(':') || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[. ]$/.test(p))) {
    throw new Error(`Use a workspace-relative slash-separated file path without traversal or .git access: ${value}`);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseProposal(input: string): Proposal {
  if (Buffer.byteLength(input, 'utf8') > MAX_BUNDLE_BYTES) throw new Error('Proposal exceeds the 10 MiB limit.');
  const root = object(JSON.parse(input.replace(/^\uFEFF/, '')), 'proposal');
  keys(root, ['schemaVersion', 'id', 'title', 'groups', '$schema'], 'proposal');
  if (root.schemaVersion !== 1) throw new Error('Only proposal schemaVersion 1 is supported.');
  text(root.id, 'proposal.id', 200); text(root.title, 'proposal.title', 300);
  if (root.$schema !== undefined) text(root.$schema, '$schema', 2048);
  list(root.groups, 'groups', 1, 100);
  const ids = new Set<string>();
  for (const value of root.groups) {
    const group = object(value, 'group');
    keys(group, ['id', 'title', 'kind', 'priority', 'reason', 'benefit', 'tradeoffs', 'documentation', 'checks', 'files'], 'group');
    text(group.id, 'group.id', 200); text(group.title, 'group.title', 300); text(group.reason, 'group.reason');
    if (ids.has(group.id)) throw new Error(`Duplicate recommendation id: ${group.id}`);
    ids.add(group.id);
    choices(group.kind, ['bug', 'refactor', 'optimization'], 'group.kind');
    choices(group.priority, ['high', 'medium', 'low'], 'group.priority');
    for (const field of ['benefit', 'tradeoffs']) if (group[field] !== undefined) text(group[field], field);
    list(group.documentation, 'documentation', 0, 20);
    for (const value of group.documentation) {
      const doc = object(value, 'documentation item'); keys(doc, ['title', 'url'], 'documentation item');
      text(doc.title, 'documentation.title', 300); text(doc.url, 'documentation.url', 2048);
      const url = new URL(doc.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Documentation links must be HTTPS URLs without credentials.');
    }
    list(group.checks, 'checks', 0, 30);
    for (const value of group.checks) {
      const check = object(value, 'check'); keys(check, ['description', 'status', 'detail'], 'check');
      text(check.description, 'check.description', 1000);
      choices(check.status, ['passed', 'failed', 'not-run'], 'check.status');
      if (check.detail !== undefined) text(check.detail, 'check.detail');
    }
    list(group.files, 'files', 1, 50);
    const names = new Set<string>();
    for (const value of group.files) {
      const file = object(value, 'file'); keys(file, ['path', 'before', 'after', 'baseSha256'], 'file');
      validateRelativePath(file.path);
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
      if (names.has(key)) throw new Error(`Duplicate path in a recommendation: ${file.path}`);
      names.add(key);
      text(file.before, 'file.before', MAX_TEXT_LENGTH, true); text(file.after, 'file.after', MAX_TEXT_LENGTH, true);
      if (typeof file.baseSha256 !== 'string' || file.baseSha256 !== sha256(file.before)) throw new Error(`Invalid original-content hash: ${file.path}`);
      if (normalizeText(file.before) === normalizeText(file.after)) throw new Error(`Proposed change does not change ${file.path}.`);
      file.before = normalizeText(file.before); file.after = normalizeText(file.after);
    }
  }
  return freeze(root as unknown as Proposal);
}

/** Resolve only regular, single-link files beneath a real filesystem root. */
export function resolveFile(root: string, relative: string): string {
  validateRelativePath(relative);
  const base = fs.realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links/junctions are unsupported: ${relative}`);
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.nlink > 1) throw new Error(`Only regular, single-link files are supported: ${relative}`);
  if (stat.size > 4 * MAX_TEXT_LENGTH) throw new Error(`File is too large: ${relative}`);
  const actual = fs.realpathSync(current);
  const distance = path.relative(base, actual);
  if (!distance || distance.startsWith('..' + path.sep) || distance === '..' || path.isAbsolute(distance)) throw new Error('Target escapes the workspace.');
  return actual;
}
export function readUtf8(file: string, limit = 4 * MAX_TEXT_LENGTH): string {
  if (fs.statSync(file).size > limit) throw new Error(`File exceeds the supported size: ${path.basename(file)}`);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  if (value.includes('\0')) throw new Error('Binary and UTF-16 files are unsupported.');
  return normalizeText(value);
}

/** A session owns decisions and serializes application; previews never mutate files. */
export class ReviewSession {
  readonly root: string;
  readonly fingerprint: string;
  private decisions = new Map<string, Decision>();
  private applying = false;
  constructor(root: string, readonly proposal: Proposal, remembered: Record<string, Decision> = {}) {
    this.root = fs.realpathSync(root);
    this.fingerprint = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    for (const group of proposal.groups) {
      const saved = remembered[group.id];
      this.decisions.set(group.id, saved === 'accepted' || saved === 'rejected' ? saved : 'pending');
    }
  }
  get busy(): boolean { return this.applying; }
  group(id: string): Recommendation {
    const found = this.proposal.groups.find(group => group.id === id);
    if (!found) throw new Error('Recommendation does not belong to this review.');
    return found;
  }
  savedDecisions(): Record<string, Decision> { return Object.fromEntries(this.decisions); }
  status(id: string, buffers?: Pick<WorkspacePort, 'current'>): Status {
    const decision = this.decisions.get(id);
    if (!decision) throw new Error('Unknown recommendation.');
    if (decision !== 'pending') return { state: decision };
    try {
      for (const change of this.group(id).files) {
        const target = resolveFile(this.root, change.path);
        if (sha256(readUtf8(target)) !== change.baseSha256) return { state: 'stale', reason: `${change.path} changed on disk. Regenerate the proposal.` };
        const document = buffers?.current(target);
        if (document && sha256(document.text) !== change.baseSha256) return { state: 'stale', reason: `${change.path} has different editor contents. Regenerate the proposal.` };
      }
      return { state: 'pending' };
    } catch (error) { return { state: 'stale', reason: error instanceof Error ? error.message : String(error) }; }
  }
  reject(id: string): void {
    if (this.applying) throw new Error('Wait for the current acceptance to finish.');
    this.group(id);
    if (this.decisions.get(id) !== 'pending') throw new Error('Recommendation is already resolved.');
    this.decisions.set(id, 'rejected');
  }
  async accept(id: string, port: WorkspacePort): Promise<void> {
    if (this.applying) throw new Error('Another recommendation is being applied.');
    if (this.decisions.get(id) !== 'pending') throw new Error('Recommendation is already resolved.');
    const group = this.group(id);
    this.applying = true;
    try {
      const targets = group.files.map(change => resolveFile(this.root, change.path));
      for (const target of targets) await port.open(target);
      // No await separates this final content/path check from the apply call.
      const status = this.status(id, port);
      if (status.state !== 'pending') throw new Error(status.reason ?? 'Proposal is stale.');
      const edits = group.files.map((change, index) => {
        const buffer = port.current(targets[index]);
        if (!buffer) throw new Error('Editor buffer is unavailable.');
        return { absolutePath: targets[index], after: change.after, version: buffer.version };
      });
      if (!await port.apply(edits)) throw new Error('VS Code declined the grouped edit. No recommendation was marked accepted.');
      this.decisions.set(id, 'accepted');
    } finally { this.applying = false; }
  }
}

/** Capture original disk contents for a plan; does not modify any target file. */
export function buildProposal(root: string, plan: unknown, planDirectory: string): Proposal {
  const input = object(plan, 'plan');
  keys(input, ['id', 'title', 'groups'], 'plan');
  list(input.groups, 'plan.groups', 1, 100);
  const groups = input.groups.map(value => {
    const group = object(value, 'plan group');
    keys(group, ['id', 'title', 'kind', 'priority', 'reason', 'benefit', 'tradeoffs', 'documentation', 'checks', 'files'], 'plan group');
    list(group.files, 'plan group files', 1, 50);
    const files = group.files.map(value => {
      const file = object(value, 'plan file'); keys(file, ['path', 'proposedFile'], 'plan file');
      validateRelativePath(file.path); text(file.proposedFile, 'proposedFile', 4096);
      const before = readUtf8(resolveFile(root, file.path));
      const after = readUtf8(path.resolve(planDirectory, file.proposedFile));
      return { path: file.path, before, after, baseSha256: sha256(before) };
    });
    return { ...group, files };
  });
  return parseProposal(JSON.stringify({ schemaVersion: 1, id: input.id, title: input.title, groups }));
}
