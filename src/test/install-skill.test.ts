import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installCompanionSkill } from '../install-skill';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposals-skill-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'review-proposals-skill-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
test('companion installation updates our files and preserves unrelated skills', t => {
  const root = fixture(t);
  const unrelated = path.join(root, '.agents/skills/user-skill/SKILL.md'); fs.mkdirSync(path.dirname(unrelated), { recursive: true }); fs.writeFileSync(unrelated, 'keep');
  installCompanionSkill(process.cwd(), root, 'Jeromemoores.review-proposals', '0.1.0');
  for (const agent of ['.claude', '.agents']) {
    const skill = path.join(root, agent, 'skills/propose-code-review');
    assert.ok(fs.existsSync(path.join(skill, 'scripts/core.js')));
    fs.writeFileSync(path.join(skill, 'scripts/core.js'), 'older version');
  }
  installCompanionSkill(process.cwd(), root, 'Jeromemoores.review-proposals', '0.1.1');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(root, '.claude/skills/propose-code-review/scripts/core.js'), 'utf8'), fs.readFileSync('out/core.js', 'utf8'));
});
test('an unmanaged existing skill blocks both installations before any write', t => {
  const root = fixture(t), skill = path.join(root, '.agents/skills/propose-code-review');
  fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), 'user content');
  assert.throws(() => installCompanionSkill(process.cwd(), root, 'Jeromemoores.review-proposals', '0.1.0'), /unmanaged/);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), 'user content');
});
test('another extension marker does not authorize overwriting a skill', t => {
  const root = fixture(t), skill = path.join(root, '.claude/skills/propose-code-review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, '.review-proposals-managed.json'), JSON.stringify({ extension: 'someone-else' }));
  assert.throws(() => installCompanionSkill(process.cwd(), root, 'Jeromemoores.review-proposals', '0.1.0'), /unmanaged/);
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});
