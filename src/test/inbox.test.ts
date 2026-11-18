import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { INBOX, newestPublishedReview, publishProposal } from '../inbox';
import { parseProposal, Proposal, sha256 } from '../core';

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'review-inbox-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('review-inbox-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.ts'), 'before\n');
  const proposal = parseProposal(JSON.stringify({ schemaVersion: 1, id: 'one', title: 'Review', groups: [{
    id: 'change', title: 'One change', kind: 'bug', priority: 'high', reason: 'An observable defect.', documentation: [], checks: [],
    files: [{ path: 'a.ts', before: 'before\n', after: 'after\n', baseSha256: sha256('before\n') }]
  }] }));
  return { base, root, proposal };
}

test('discovery before publication is read-only and creates no folders', t => {
  const f = fixture(t);
  assert.equal(newestPublishedReview([f.root]).review, undefined);
  assert.deepEqual(fs.readdirSync(f.root), ['a.ts']);
});
test('atomic publication produces complete unique reviews without source edits or temporary leftovers', t => {
  const f = fixture(t);
  const first = publishProposal(f.root, f.proposal), second = publishProposal(f.root, f.proposal);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.ts'), 'utf8'), 'before\n');
  assert.deepEqual(fs.readdirSync(path.join(f.root, INBOX)).sort(), [path.basename(first), path.basename(second)].sort());
  assert.equal(newestPublishedReview([f.root]).review?.proposal.id, 'one');
});
test('partial and malformed files cannot replace the latest valid review', t => {
  const f = fixture(t), good = publishProposal(f.root, f.proposal);
  fs.writeFileSync(path.join(f.root, INBOX, 'writing.json.tmp'), '{');
  const invalid = path.join(f.root, INBOX, 'invalid.json'); fs.writeFileSync(invalid, '{');
  fs.utimesSync(invalid, new Date(), new Date(Date.now() + 10000));
  const result = newestPublishedReview([f.root]);
  assert.equal(result.review?.source, good);
  assert.equal(result.issues.length, 1);
});
test('newest review keeps the owning root across multiple workspaces', t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  const earlier = publishProposal(f.root, f.proposal);
  fs.utimesSync(earlier, new Date(1000), new Date(1000));
  const newer = publishProposal(other, { ...f.proposal, id: 'other' });
  const result = newestPublishedReview([f.root, other]);
  assert.equal(result.review?.source, newer); assert.equal(result.review?.root, other);
});
test('publication and discovery refuse a linked inbox directory', t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.root, '.review-proposals'));
  fs.symlinkSync(outside, path.join(f.root, INBOX), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => publishProposal(f.root, f.proposal), /real directory/);
  assert.equal(newestPublishedReview([f.root]).review, undefined);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('standalone CLI can publish directly instead of requiring an output filename', t => {
  const f = fixture(t), replacement = path.join(f.base, 'replacement.ts'); fs.writeFileSync(replacement, 'after\n');
  const plan = { ...f.proposal, schemaVersion: undefined, groups: f.proposal.groups.map(group => ({
    ...group, files: [{ path: 'a.ts', proposedFile: replacement }]
  })) };
  delete (plan as { schemaVersion?: number }).schemaVersion;
  const file = path.join(f.base, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const args = [path.resolve('tools/create-proposal.cjs'), '--workspace', f.root, '--plan', file, '--publish'];
  assert.match(execFileSync(process.execPath, args, { encoding: 'utf8' }), /Published/);
  const found = newestPublishedReview([f.root]).review!;
  assert.equal(found.proposal.groups[0].files[0].after, 'after\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'a.ts'), 'utf8'), 'before\n');
});
