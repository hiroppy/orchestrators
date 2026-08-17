#!/usr/bin/env node

import config from "orchestrator-config/runtime";
import { startWatcher } from "../watcher/start-watcher.ts";

startWatcher(config).catch((error: Error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
