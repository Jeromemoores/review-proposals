#!/usr/bin/env node
// The installed companion skill keeps core.js beside this file.
const fs = require('node:fs');
const path = require('node:path');
const core = require(fs.existsSync(path.join(__dirname, 'core.js')) ? './core.js' : '../out/core.js');

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workspace', '--plan', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error('Usage: node create-proposal.cjs --workspace ROOT --plan PLAN.json --output NEW-PROPOSAL.json');
    }
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error('Supply --workspace, --plan and --output.');
  const planPath = path.resolve(options['--plan']);
  const plan = JSON.parse(core.readUtf8(planPath, core.MAX_BUNDLE_BYTES));
  const proposal = core.buildProposal(path.resolve(options['--workspace']), plan, path.dirname(planPath));
  const output = path.resolve(options['--output']);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Exclusive creation prevents overwriting source or a previous proposal.
  fs.writeFileSync(output, JSON.stringify(proposal, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`Created ${output}; ${proposal.groups.length} recommendation(s). Target files were not changed.`);
}
try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
