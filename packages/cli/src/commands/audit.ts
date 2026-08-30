import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AgentEvalClient } from '@agent-eval/sdk';

const client = new AgentEvalClient('http://localhost:3000', 'mock-api-key');
export const auditCommand = new Command('audit')
  .description('Manage audit trail');

auditCommand
  .command('query')
  .description('Query audit log')
  .option('--from <date>', 'Start date')
  .option('--to <date>', 'End date')
  .option('--type <type>', 'Event type')
  .action(async (options) => {
    try {
      const logs = await client.audit.query(options);
      console.log(chalk.blue('Audit logs:'));
      logs.forEach(log => console.log(`- [${log.timestamp}] ${log.type}: ${log.id}`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

auditCommand
  .command('prove')
  .description('Get and verify Merkle inclusion proof')
  .argument('<eventId>', 'Event ID')
  .action(async (eventId) => {
    const spinner = ora('Verifying proof...').start();
    try {
      const proof = await client.audit.getProof(eventId);
      spinner.succeed(chalk.green(`Proof verified for event ${eventId}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to verify proof: ${error}`));
    }
  });

auditCommand
  .command('verify-chain')
  .description('Verify full chain integrity')
  .action(async () => {
    const spinner = ora('Verifying chain...').start();
    try {
      const isValid = await client.audit.verifyChain();
      if (isValid) {
        spinner.succeed(chalk.green('Chain integrity verified'));
      } else {
        spinner.fail(chalk.red('Chain integrity check failed'));
      }
    } catch (error) {
      spinner.fail(chalk.red(`Failed to verify chain: ${error}`));
    }
  });
