#!/usr/bin/env node
/**
 * agent-eval CLI.
 *
 * Three commands were removed rather than kept: `env` targeted an
 * /environments API that does not exist, `server start` printed "Server
 * started on port 3000" without starting anything, and `verify fuzz` waited a
 * second and reported success for work it never did. A command that reports
 * success for nothing is worse than a missing one — it is believed.
 *
 * Verifier fuzzing and isomorphic perturbation testing are genuinely not
 * implemented anywhere in this codebase. They are listed under `roadmap` so
 * that their absence is visible rather than implied by silence.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { auditCommand } from './commands/audit';
import { evidenceCommand } from './commands/evidence';
import { keysCommand } from './commands/keys';
import { credentialsCommand, modelsCommand, providersCommand } from './commands/providers';
import { runCommand } from './commands/run';
import { CliError } from './client';

const program = new Command();

program
  .name('agent-eval')
  .description(
    'Control plane for auditable agent evaluation.\n\n' +
      'Configuration:\n' +
      '  AGENT_EVAL_URL           control plane base URL (default http://127.0.0.1:8080)\n' +
      '  AGENT_EVAL_API_KEY       an ae_live_ key, or a development token\n' +
      '  AGENT_EVAL_PROVIDER_KEY  a provider secret, read only by `credentials add`',
  )
  .version('1.0.0');

program.addCommand(runCommand);
program.addCommand(providersCommand);
program.addCommand(modelsCommand);
program.addCommand(credentialsCommand);
program.addCommand(evidenceCommand);
program.addCommand(auditCommand);
program.addCommand(keysCommand);

program
  .command('whoami')
  .description('Show what the configured credential can do')
  .action(async () => {
    const { createClient } = await import('./client');
    const me = await createClient().me();
    console.log(`  tenant  ${me.tenantId}`);
    console.log(`  actor   ${me.actor}`);
    console.log(`  scopes  ${me.scopes.join(', ')}`);
  });

program
  .command('roadmap')
  .description('What this CLI does NOT do yet')
  .action(() => {
    console.log(
      [
        '  NOT IMPLEMENTED — no code exists for these anywhere in the repository:',
        '',
        '    verifier fuzzing         generating adversarial inputs against a verifier',
        '    isomorphic perturbation  semantically-equal task rewrites to detect overfit',
        '    canary hack-tasks        deliberately unsolvable tasks to detect reward hacking',
        '    server lifecycle         start/stop; run the server directly instead',
        '    environment registry     no /environments API exists; pass a digest to `runs start`',
        '',
        '  These were previously commands that printed success without doing anything.',
      ].join('\n'),
    );
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(chalk.red(`\n  ${e.message}\n`));
    } else {
      const problem = (e as { problem?: { status: number; detail?: string; title: string; field?: string } }).problem;
      if (problem) {
        // The server said something specific. Repeat it rather than replacing
        // it with a generic failure.
        console.error(chalk.red(`\n  ${problem.status} ${problem.detail ?? problem.title}`));
        if (problem.field) console.error(chalk.dim(`  field: ${problem.field}`));
        console.error('');
      } else {
        console.error(chalk.red(`\n  ${(e as Error).message}\n`));
      }
    }
    process.exitCode = 1;
  }
}

void main();
