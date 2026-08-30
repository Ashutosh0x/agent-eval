#!/usr/bin/env node
import { Command } from 'commander';
import { envCommand } from './commands/env';
import { runCommand } from './commands/run';
import { evidenceCommand } from './commands/evidence';
import { auditCommand } from './commands/audit';
import { verifyCommand } from './commands/verify';
import { serverCommand } from './commands/server';

const program = new Command();

program
  .name('agent-eval')
  .description('CLI for agent evaluation and compliance')
  .version('1.0.0');

program.addCommand(envCommand);
program.addCommand(runCommand);
program.addCommand(evidenceCommand);
program.addCommand(auditCommand);
program.addCommand(verifyCommand);
program.addCommand(serverCommand);

program.parse(process.argv);
