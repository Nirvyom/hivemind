import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import { paths, ensureDir } from '../config/index.js';

let _logger: pino.Logger | null = null;

export function getLogger(name?: string): pino.Logger {
  if (!_logger) {
    ensureDir();
    const logFile = path.join(paths.logs, 'hivemind.log');

    _logger = pino({
      level: process.env.HIVEMIND_LOG_LEVEL || 'info',
      transport: process.stdout.isTTY
        ? {
            target: 'pino-pretty',
            options: { colorize: true },
          }
        : undefined,
    }, process.stdout.isTTY ? undefined : pino.destination({
      dest: logFile,
      sync: false,
      mkdir: true,
    }));
  }

  return name ? _logger.child({ component: name }) : _logger;
}

export function getAgentLogger(agentName: string): pino.Logger {
  ensureDir();
  const logFile = path.join(paths.logs, `${agentName}.log`);

  return pino({
    level: 'info',
  }, pino.destination({
    dest: logFile,
    sync: false,
    mkdir: true,
  }));
}

export function readLogFile(agentName?: string, lines: number = 50): string[] {
  const logFile = agentName
    ? path.join(paths.logs, `${agentName}.log`)
    : path.join(paths.logs, 'hivemind.log');

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.trim().split('\n');
  return allLines.slice(-lines);
}
