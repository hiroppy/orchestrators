#!/usr/bin/env node

import config from "#watcher-config";
import { startWatcher } from "../watcher/runner.ts";

startWatcher(config, process.argv.slice(2)).catch((error: Error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
