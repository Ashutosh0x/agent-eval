/**
 * Evidence commands.
 *
 * `evidence verify` deliberately offers two modes, and the distinction is the
 * point of the whole product:
 *
 *   --remote   asks the control plane whether its own bundle is good. Useful
 *              for a quick check, worthless as an audit.
 *   (default)  verifies a downloaded bundle locally against a public key,
 *              touching no network and trusting no server.
 *
 * If only the first existed, the bundle would not be evidence — it would be a
 * claim that the system makes about itself.
 */

import { writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../client';

export const evidenceCommand = new Command('evidence').description(
  'Generate, download and verify evidence bundles',
);

evidenceCommand
  .command('generate')
  .description('Sign an evidence bundle over a run')
  .argument('<runId>')
  .option('--retention <rules>', 'Comma-separated retention bases', 'eu-ai-act-art-19')
  .action(async (runId: string, o: { retention: string }) => {
    const rules = o.retention.split(',').map((s) => s.trim());
    const { bundleId, bundle } = await createClient().evidence.generate(runId, rules);
    console.log(`  ${bundleId}`);
    console.log(`  entries    ${bundle.payload.entries.map((e) => e.seq).join(', ')}`);
    console.log(`  logRoot    ${bundle.payload.logRoot}`);
    console.log(`  signature  ${bundle.signature.algorithm} / ${bundle.signature.keyId}`);
    console.log(`  retain to  ${bundle.payload.retention.retainUntil}`);
  });

evidenceCommand
  .command('download')
  .description('Download a bundle together with the public key that verifies it')
  .argument('<bundleId>')
  .option('--out <path>', 'Where to write it', 'bundle.json')
  .action(async (bundleId: string, o: { out: string }) => {
    const offline = await createClient().evidence.offline(bundleId);
    writeFileSync(o.out, JSON.stringify(offline, null, 2));
    console.log(`  wrote ${o.out}`);
    console.log(chalk.dim(`  Verify it with no network access: agent-eval evidence verify ${o.out}`));
  });

evidenceCommand
  .command('verify')
  .description('Verify a downloaded bundle locally, or ask the server about one')
  .argument('[file]', 'A file written by `evidence download`')
  .option('--remote <bundleId>', 'Ask the control plane instead (not an independent check)')
  .action(async (file: string | undefined, o: { remote?: string }) => {
    if (o.remote) {
      const result = await createClient().evidence.verify(o.remote);
      report(result.valid, result.checks, result.failures);
      console.log(
        chalk.yellow(
          '\n  This asked the system that produced the bundle whether the bundle is good.\n' +
            '  For an audit, download it and verify locally instead.',
        ),
      );
      if (!result.valid) process.exitCode = 1;
      return;
    }

    if (!file) {
      throw new Error(
        'Pass a bundle file, or --remote <bundleId> to ask the server.\n' +
          '  Get a file with: agent-eval evidence download <bundleId>',
      );
    }

    const { verifyLocalBundle } = await import('../verify-local');
    const result = verifyLocalBundle(file);
    report(result.valid, result.checks, result.failures);
    if (!result.valid) process.exitCode = 1;
  });

function report(valid: boolean, checks: Record<string, boolean>, failures: string[]) {
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? chalk.green('PASS') : chalk.red('FAIL')}  ${name}`);
  }
  for (const f of failures) console.log(chalk.red(`        ${f}`));
  console.log(`\n  ${valid ? chalk.green('BUNDLE VALID') : chalk.red('BUNDLE INVALID')}`);
}
