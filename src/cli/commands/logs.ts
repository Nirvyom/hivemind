import chalk from 'chalk';
import { readLogFile } from '../../utils/logger.js';

export async function logsCommand(agent?: string, opts?: { lines?: string }): Promise<void> {
  const lines = parseInt(opts?.lines || '50', 10);
  const logLines = readLogFile(agent || undefined, lines);

  if (logLines.length === 0) {
    console.log(chalk.yellow(agent
      ? `No logs found for agent: ${agent}`
      : 'No logs found. Start the daemon first.'));
    return;
  }

  console.log(chalk.bold.cyan(`\n  Logs${agent ? ` — ${agent}` : ''} (last ${logLines.length} lines)\n`));

  for (const line of logLines) {
    try {
      const parsed = JSON.parse(line);
      const level = parsed.level;
      const msg = parsed.msg || '';
      const time = parsed.time ? new Date(parsed.time).toLocaleTimeString() : '';

      let colorFn = chalk.white;
      if (level >= 50) colorFn = chalk.red;
      else if (level >= 40) colorFn = chalk.yellow;
      else if (level >= 30) colorFn = chalk.cyan;
      else colorFn = chalk.dim;

      const component = parsed.component ? `[${parsed.component}]` : '';
      console.log(`  ${chalk.dim(time)} ${component} ${colorFn(msg)}`);
    } catch {
      console.log(`  ${line}`);
    }
  }

  console.log('');
}
