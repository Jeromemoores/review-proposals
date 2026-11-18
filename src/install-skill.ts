import * as fs from 'node:fs';
import * as path from 'node:path';

/** Install only our managed skill; preflight both agents before writing either. */
export function installCompanionSkill(extensionRoot: string, profile: string, extensionId: string, version: string): void {
  const resources = [
    ['agent-skill/SKILL.md', 'SKILL.md'], ['tools/create-proposal.cjs', 'scripts/create-proposal.cjs'],
    ['out/core.js', 'scripts/core.js'], ['out/inbox.js', 'scripts/inbox.js'], ['proposal.schema.json', 'proposal.schema.json']
  ].map(([from, to]) => ({ from: path.join(extensionRoot, from), to }));
  for (const resource of resources) if (!fs.statSync(resource.from).isFile()) throw new Error('Companion skill resources are incomplete.');
  const destinations = ['.claude', '.agents'].map(agent => path.join(profile, agent, 'skills/propose-code-review'));
  for (const destination of destinations) {
    if (!fs.existsSync(destination)) continue;
    let managed = false;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(destination, '.review-proposals-managed.json'), 'utf8'));
      managed = typeof marker.extension === 'string' && marker.extension.toLowerCase() === extensionId.toLowerCase();
    } catch { /* Unknown files are not evidence that this extension owns a skill. */ }
    if (!managed) throw new Error(`Existing unmanaged skill preserved: ${destination}`);
  }
  for (const destination of destinations) {
    for (const resource of resources) {
      const output = path.join(destination, resource.to);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(resource.from, output);
    }
    fs.writeFileSync(path.join(destination, '.review-proposals-managed.json'), JSON.stringify({ extension: extensionId, version }) + '\n');
  }
}
