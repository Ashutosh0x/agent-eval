/**
 * Audit log commands.
 *
 * `audit verify` checks the chain across the whole log, which is a different
 * question from whether a bundle is good: the chain proves nothing was removed
 * from the middle of the log, and a bundle's inclusion proofs prove particular
 * entries are in it.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../client';

export const auditCommand = new Command('audit').description('Query and verify the audit log');

auditCommand
  .command('query')
  .description('List audit entries')
  .option('--actor <actor>')
  .option('--action <action>')
  .option('--subject <subject>')
  .option('--limit <n>', 'How many to return', '20')
  .action(async (o: { actor?: string; action?: string; subject?: string; limit: string }) => {
    const { items } = await createClient().audit.query({
      ...(o.actor ? { actor: o.actor } : {}),
      ...(o.action ? { action: o.action } : {}),
      ...(o.subject ? { subject: o.subject } : {}),
      limit: Number(o.limit),
    });
    for (const e of items) {
      console.log(
        `  ${String(e.seq).padStart(5)}  ${e.action.padEnd(26)} ${e.subject.padEnd(18)} ${e.actor}`,
      );
    }
    console.log(chalk.dim(`\n  ${items.length} entries.`));
  });

auditCommand
  .command('root')
  .description('Show the current Merkle root and log size')
  .action(async () => {
    const { root, size } = await createClient().audit.root();
    console.log(`  root  ${root}`);
    console.log(`  size  ${size}`);
  });

auditCommand
  .command('verify')
  .description('Verify the hash chain across the whole log')
  .action(async () => {
    const result = await createClient().audit.verify();
    if (result.valid) {
      console.log(`  ${chalk.green('CHAIN INTACT')}`);
    } else {
      console.log(`  ${chalk.red('CHAIN BROKEN')} at entry ${result.brokenAt}`);
      console.log(`  ${result.reason ?? ''}`);
      process.exitCode = 1;
    }
  });

auditCommand
  .command('proof')
  .description('Get an inclusion proof for one entry')
  .argument('<seq>', 'Sequence number')
  .action(async (seq: string) => {
    const { proof, leaf, root } = await createClient().audit.inclusionProof(Number(seq));
    console.log(`  leaf       ${leaf}`);
    console.log(`  root       ${root}`);
    console.log(`  treeSize   ${proof.treeSize}`);
    console.log(`  path       ${proof.path.length} nodes`);
    for (const node of proof.path) console.log(chalk.dim(`             ${node}`));
  });

auditCommand
  .command('consistency')
  .description('Prove an earlier root is a prefix of a later one (append-only evidence)')
  .argument('<first>', 'Earlier tree size')
  .argument('<second>', 'Later tree size')
  .action(async (first: string, second: string) => {
    const { path } = await createClient().audit.consistencyProof(Number(first), Number(second));
    console.log(`  ${path.length} nodes`);
    for (const node of path) console.log(chalk.dim(`  ${node}`));
  });
