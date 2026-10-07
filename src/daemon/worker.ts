#!/usr/bin/env node

// This is the daemon worker process that runs in the background
import { runDaemon } from './index.js';

runDaemon().catch((err) => {
  console.error('Daemon failed to start:', err);
  process.exit(1);
});
