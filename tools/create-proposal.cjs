#!/usr/bin/env node
// The installed companion skill keeps core.js beside this file.
const fs = require('node:fs');
const path = require('node:path');
const core = require(fs.existsSync(path.join(__dirname, 'core.js')) ? './core.js' : '../out/core.js');
const inbox = require(fs.existsSync(path.join(__dirname, 'inbox.js')) ? './inbox.js' : '../out/inbox.js');

function main(args) {
  const options = {};
  for (let i = 0; i < args.length;) {
    if (args[i] === '--publish' && !options.publish) { options.publish = true; i++; continue; }
    if (!['--workspace', '--plan', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error('Usage: node create-proposal.cjs --workspace ROOT --plan PLAN.json (--publish | --output NEW-PROPOSAL.json)');
    }
    options[args[i]] = args[i + 1];
    i += 2;
  }
  if (!options['--workspace'] || !options['--plan'] || !!options.publish === !!options['--output']) throw new Error('Supply --workspace, --plan and either --publish or --output.');
  const planPath = path.resolve(options['--plan']);
  const plan = JSON.parse(core.readUtf8(planPath, core.MAX_BUNDLE_BYTES));
  const proposal = core.buildProposal(path.resolve(options['--workspace']), plan, path.dirname(planPath));
  if (options.publish) {
    const output = inbox.publishProposal(path.resolve(options['--workspace']), proposal);
    console.log(`Published ${output}; ${proposal.groups.length} recommendation(s). Open Review Proposals to see them automatically. Target files were not changed.`);
    return;
  }
  const output = path.resolve(options['--output']);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Exclusive creation prevents overwriting source or a previous proposal.
  fs.writeFileSync(output, JSON.stringify(proposal, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`Created ${output}; ${proposal.groups.length} recommendation(s). Target files were not changed.`);
}
try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
