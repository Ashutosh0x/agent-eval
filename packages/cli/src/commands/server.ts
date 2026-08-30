import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

export const serverCommand = new Command('server')
  .description('Manage server');

serverCommand
  .command('start')
  .description('Start the server')
  .action(async () => {
    console.log(chalk.green('Server started on port 3000'));
  });

serverCommand
  .command('stop')
  .description('Stop the server')
  .action(async () => {
    console.log(chalk.yellow('Server stopped'));
  });
