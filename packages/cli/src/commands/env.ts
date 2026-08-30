import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AgentEvalClient } from '@agent-eval/sdk';

const client = new AgentEvalClient('http://localhost:3000', 'mock-api-key');
export const envCommand = new Command('env')
  .description('Manage environments');

envCommand
  .command('import')
  .description('Import an OpenEnv/verifiers environment')
  .argument('<source>', 'Source URI')
  .action(async (source) => {
    const spinner = ora('Importing environment...').start();
    try {
      const res = await client.environments.import(source);
      spinner.succeed(chalk.green(`Imported environment successfully: ${res.id}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to import: ${error}`));
    }
  });

envCommand
  .command('list')
  .description('List environments')
  .action(async () => {
    try {
      const list = await client.environments.list();
      console.log(chalk.blue('Environments:'));
      list.forEach(env => console.log(`- ${env.id}: ${env.name}`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

envCommand
  .command('validate')
  .description('Validate environment spec')
  .argument('<id>', 'Environment ID')
  .action(async (id) => {
    const spinner = ora('Validating environment...').start();
    try {
      // Mock validation
      spinner.succeed(chalk.green(`Environment ${id} is valid`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to validate: ${error}`));
    }
  });
