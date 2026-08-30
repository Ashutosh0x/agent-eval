/**
 * Run commands.
 *
 * `runs start` takes every field the manifest needs, and requires most of
 * them. The previous version forwarded commander's options object straight to
 * the API, which meant a `--model` flag and nothing else: the server rejected
 * it every time, and the error read as though the CLI were broken rather than
 * the request being incomplete.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../client';

export const runCommand = new Command('runs').description('Start and inspect evaluation runs');

runCommand
  .command('list')
  .description('List runs')
  .action(async () => {
    const { items } = await createClient().runs.list();
    if (items.length === 0) {
      console.log('  No runs yet.');
      return;
    }
    for (const r of items) {
      const status = colourStatus(r.status);
      const reason = r.failureReason ? chalk.dim(`  ${r.failureReason.slice(0, 60)}`) : '';
      console.log(`  ${r.id.padEnd(16)} ${status.padEnd(20)} ${r.createdAt}${reason}`);
    }
  });

runCommand
  .command('get')
  .description('Show a run')
  .argument('<id>')
  .action(async (id: string) => {
    const run = await createClient().runs.get(id);
    console.log(`  id          ${run.id}`);
    console.log(`  status      ${colourStatus(run.status)}`);
    console.log(`  created     ${run.createdAt}`);
    if (run.claimedBy) console.log(`  worker      ${run.claimedBy}`);
    if (run.credentialId) console.log(`  credential  ${run.credentialId}`);
    if (run.failureReason) console.log(`  failure     ${chalk.red(run.failureReason)}`);
    console.log(`  retention   ${run.retentionRules.join(', ')}`);
  });

runCommand
  .command('entries')
  .description("Show a run's audit entries in order")
  .argument('<id>')
  .action(async (id: string) => {
    const { items } = await createClient().runs.entries(id);
    for (const e of items) {
      console.log(`  ${String(e.seq).padStart(5)}  ${e.action.padEnd(24)} ${e.recordedAt}`);
    }
  });

runCommand
  .command('start')
  .description('Queue a run')
  .requiredOption('--environment <ref>', 'Environment reference, e.g. ghcr.io/acme/env')
  .requiredOption('--digest <sha256:…>', 'Environment digest; a tag can move, a digest cannot')
  .requiredOption('--task-set <id>')
  .requiredOption('--task-set-version <version>')
  .requiredOption('--verifier <id>')
  .requiredOption('--verifier-version <version>')
  .requiredOption('--model <provider/model>', 'e.g. ollama/gemma3:4b, openai/gpt-4o-mini')
  .option('--split <split>', 'Task split', 'held-out')
  .option('--credential <id>', 'Stored provider credential to spend')
  .option('--temperature <n>', 'Sampling temperature', '0')
  .option('--seed <n>', 'Omit to record the run as deliberately unseeded')
  .option('--backend <backend>', 'Isolation backend', 'model')
  .option('--toolchain <pairs>', 'name=version,name=version', 'agent-eval=1.0.0')
  .option('--retention <rules>', 'Comma-separated retention bases', 'eu-ai-act-art-19')
  .action(async (o: Record<string, string>) => {
    const toolchain: Record<string, string> = {};
    for (const pair of o.toolchain!.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) toolchain[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }

    const { runId, status } = await createClient().runs.start({
      environmentId: o.environment!,
      environmentDigest: o.digest!,
      taskSetId: o.taskSet!,
      taskSetVersion: o.taskSetVersion!,
      split: o.split!,
      verifierId: o.verifier!,
      verifierVersion: o.verifierVersion!,
      model: { identifier: o.model!, sampling: { temperature: Number(o.temperature) } },
      ...(o.credential ? { credentialId: o.credential } : {}),
      // Explicitly null rather than absent: "this run was not seeded" is a
      // fact the manifest records, and a missing field cannot state it.
      seed: o.seed === undefined ? null : Number(o.seed),
      isolationBackend: o.backend!,
      toolchain,
      retentionRules: o.retention!.split(',').map((s) => s.trim()),
    });

    console.log(`  ${runId}  ${status}`);
    console.log(chalk.dim('  A worker will claim it. Follow with: agent-eval runs get ' + runId));
  });

runCommand
  .command('cancel')
  .description('Cancel a run')
  .argument('<id>')
  .action(async (id: string) => {
    const run = await createClient().runs.cancel(id);
    console.log(`  ${run.id}  ${colourStatus(run.status)}`);
  });

runCommand
  .command('compare')
  .description('Compare two runs for whether their results mean anything side by side')
  .argument('<runA>')
  .argument('<runB>')
  .action(async (a: string, b: string) => {
    const result = await createClient().runs.compare(a, b);
    console.log(`  comparable  ${result.comparable ? chalk.green('yes') : chalk.red('no')}`);
    for (const d of result.differences) console.log(`    ${d}`);
    if (result.note) console.log(chalk.dim(`  ${result.note}`));
  });

function colourStatus(status: string): string {
  if (status === 'completed') return chalk.green(status);
  if (status === 'failed') return chalk.red(status);
  if (status === 'running') return chalk.cyan(status);
  return chalk.dim(status);
}
