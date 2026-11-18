import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProposal, normalizeText, parseProposal, Proposal, readUtf8, resolveFile, ReviewSession, sha256, WorkspacePort } from '../core';

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposals-'));
  const root = path.join(base, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 2;\n');
  t.after(() => {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'review-proposals-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const raw = {
    schemaVersion: 1, id: 'review-1', title: 'A review', groups: [{
      id: 'group-1', title: 'Extract a calculation', kind: 'refactor', priority: 'medium', reason: 'Separate a reusable calculation from presentation.',
      benefit: 'A meaningful test boundary.', tradeoffs: 'Callers must use the extracted function.', documentation: [], checks: [{ description: 'Regression check', status: 'not-run' }],
      files: ['a.ts', 'b.ts'].map((name, index) => ({ path: name, before: readUtf8(path.join(root, name)), after: `export const ${index ? 'b' : 'a'} = ${index + 3};\n`, baseSha256: sha256(readUtf8(path.join(root, name))) }))
    }]
  };
  return { base, root, raw, proposal: () => parseProposal(JSON.stringify(raw)) };
}
function portFor(root: string) {
  const buffers = new Map<string, { text: string; version: number }>();
  const calls: string[][] = [];
  const port: WorkspacePort = {
    async open(file) { if (!buffers.has(file)) buffers.set(file, { text: readUtf8(file), version: 1 }); },
    current(file) { return buffers.get(file); },
    async apply(edits) {
      calls.push(edits.map(edit => path.relative(root, edit.absolutePath)));
      for (const edit of edits) buffers.set(edit.absolutePath, { text: edit.after, version: edit.version + 1 });
      return true;
    }
  };
  return { port, buffers, calls };
}

test('valid proposals are immutable, hashed, and preserve grouped files', t => {
  const f = fixture(t), proposal = f.proposal();
  assert.equal(proposal.groups[0].files.length, 2);
  assert.ok(Object.isFrozen(proposal.groups[0].files[0]));
  assert.throws(() => { proposal.groups[0].files[0].after = 'unexpected'; });
});
test('one acceptance submits every related text edit exactly once without writing disk', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  await session.accept('group-1', memory.port);
  assert.deepEqual(memory.calls, [['a.ts', 'b.ts']]);
  assert.equal(memory.buffers.get(path.join(f.root, 'a.ts'))?.text, f.raw.groups[0].files[0].after);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.ts'), 'utf8'), f.raw.groups[0].files[0].before);
  assert.equal(session.status('group-1').state, 'accepted');
  await assert.rejects(session.accept('group-1', memory.port), /already resolved/);
});
test('rejecting a group does not open or change files', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal());
  session.reject('group-1');
  assert.equal(session.status('group-1').state, 'rejected');
  await assert.rejects(session.accept('group-1', portFor(f.root).port), /already resolved/);
  assert.equal(readUtf8(path.join(f.root, 'a.ts')), f.raw.groups[0].files[0].before);
});
test('a changed disk target prevents the whole group from applying', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  fs.writeFileSync(path.join(f.root, 'b.ts'), 'user disk edit');
  await assert.rejects(session.accept('group-1', memory.port), /changed on disk/);
  assert.equal(memory.calls.length, 0);
  assert.equal(session.status('group-1').state, 'stale');
});
test('an unsaved editor change prevents the whole group from applying', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  memory.buffers.set(path.join(f.root, 'b.ts'), { text: 'unsaved user work', version: 3 });
  await assert.rejects(session.accept('group-1', memory.port), /editor contents/);
  assert.equal(memory.calls.length, 0);
});
test('changes during async document opening are caught by the final check', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  const open = memory.port.open;
  memory.port.open = async file => {
    await open(file);
    if (file.endsWith('b.ts')) memory.buffers.set(path.join(f.root, 'a.ts'), { text: 'new unsaved work', version: 2 });
  };
  await assert.rejects(session.accept('group-1', memory.port), /editor contents/);
  assert.equal(memory.calls.length, 0);
});
test('failed application keeps the recommendation unresolved', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  memory.port.apply = async () => false;
  await assert.rejects(session.accept('group-1', memory.port), /declined/);
  assert.equal(session.status('group-1').state, 'pending');
  assert.equal(session.busy, false);
});
test('acceptance is serialized and pending completion cannot be rejected', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  let finish!: (value: boolean) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  memory.port.apply = () => { started(); return new Promise<boolean>(resolve => { finish = resolve; }); };
  const first = session.accept('group-1', memory.port); await ready;
  await assert.rejects(session.accept('group-1', memory.port), /being applied/);
  assert.throws(() => session.reject('group-1'), /Wait/);
  finish(true); await first;
  assert.equal(session.status('group-1').state, 'accepted');
});
test('a missing target opens no apply path and remains stale', async t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  fs.unlinkSync(path.join(f.root, 'b.ts'));
  await assert.rejects(session.accept('group-1', memory.port));
  assert.equal(memory.calls.length, 0);
});
test('independent groups touching an accepted file become stale rather than silently rebasing', async t => {
  const f = fixture(t);
  const second = structuredClone(f.raw.groups[0]); second.id = 'alternative'; f.raw.groups.push(second);
  const session = new ReviewSession(f.root, f.proposal()), memory = portFor(f.root);
  await session.accept('group-1', memory.port);
  assert.equal(session.status('alternative', memory.port).state, 'stale');
  await assert.rejects(session.accept('alternative', memory.port), /editor contents/);
});
test('remembered decisions are scoped to valid group states', t => {
  const f = fixture(t), session = new ReviewSession(f.root, f.proposal(), { 'group-1': 'rejected' });
  assert.deepEqual(session.savedDecisions(), { 'group-1': 'rejected' });
});
test('newlines and UTF-8 BOM normalize consistently', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'a.ts'), '\uFEFFexport const a = 1;\r\n');
  assert.equal(sha256(readUtf8(path.join(f.root, 'a.ts'))), f.raw.groups[0].files[0].baseSha256);
  assert.equal(normalizeText('\uFEFFx\r\n'), 'x\n');
});
test('invalid hashes, duplicate groups, unknown fields and invalid links are rejected', t => {
  const f = fixture(t);
  const mutate = (change: (raw: any) => void) => { const raw = structuredClone(f.raw); change(raw); assert.throws(() => parseProposal(JSON.stringify(raw))); };
  mutate(raw => { raw.groups[0].files[0].baseSha256 = '0'.repeat(64); });
  mutate(raw => { raw.groups.push(raw.groups[0]); });
  mutate(raw => { raw.groups[0].files.push(raw.groups[0].files[0]); });
  mutate(raw => { raw.groups[0].shell = 'do not execute'; });
  mutate(raw => { raw.groups[0].documentation = [{ title: 'unsafe', url: 'command:workbench.action.files.save' }]; });
  mutate(raw => { raw.groups[0].checks[0].status = 'probably'; });
  mutate(raw => { raw.groups[0].files[0].after = raw.groups[0].files[0].before; });
});
test('absolute, traversal, Windows alternate streams and git paths are rejected', t => {
  const f = fixture(t);
  for (const name of ['../outside.ts', '/etc/file', 'C:/file', 'a.ts:stream', '.git/config', 'src/../a.ts', 'src\\a.ts', 'src//a.ts']) {
    const raw = structuredClone(f.raw); raw.groups[0].files[0].path = name;
    assert.throws(() => parseProposal(JSON.stringify(raw)), Error, name);
  }
});
test('symbolic link/junction escapes are rejected before reading target contents', t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'outside');
  fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveFile(f.root, 'linked/secret.ts'), /Symbolic links/);
});
test('hard-linked targets are not supported', t => {
  const f = fixture(t); fs.linkSync(path.join(f.root, 'a.ts'), path.join(f.base, 'other.ts'));
  assert.throws(() => resolveFile(f.root, 'a.ts'), /single-link/);
});
test('binary and invalid UTF-8 inputs are rejected', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'a.ts'), Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(() => readUtf8(path.join(f.root, 'a.ts')));
  fs.writeFileSync(path.join(f.root, 'a.ts'), Buffer.from([65, 0, 66]));
  assert.throws(() => readUtf8(path.join(f.root, 'a.ts')), /Binary/);
});
test('plan generator captures originals and replacement files without modifying targets', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, 'replacement.ts'), 'export const a = 9;\n');
  const plan = { id: 'from-plan', title: 'From plan', groups: [{ ...f.raw.groups[0], files: [{ path: 'a.ts', proposedFile: 'replacement.ts' }] }] };
  const proposal = buildProposal(f.root, plan, f.base);
  assert.equal(proposal.groups[0].files[0].after, 'export const a = 9;\n');
  assert.equal(readUtf8(path.join(f.root, 'a.ts')), f.raw.groups[0].files[0].before);
});
test('CLI emits a valid proposal and refuses overwriting existing output', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.base, 'replacement.ts'), 'export const a = 10;\n');
  const plan = { id: 'cli', title: 'CLI review', groups: [{ ...f.raw.groups[0], files: [{ path: 'a.ts', proposedFile: 'replacement.ts' }] }] };
  const planFile = path.join(f.base, 'plan.json'), output = path.join(f.base, 'proposal.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const args = [path.resolve('tools/create-proposal.cjs'), '--workspace', f.root, '--plan', planFile, '--output', output];
  execFileSync(process.execPath, args);
  assert.equal(parseProposal(fs.readFileSync(output, 'utf8')).id, 'cli');
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  assert.equal(readUtf8(path.join(f.root, 'a.ts')), f.raw.groups[0].files[0].before);
});
