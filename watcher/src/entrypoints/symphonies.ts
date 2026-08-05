#!/usr/bin/env node

import config from "orchestrator-config/runtime";
import { startSymphonies } from "../symphonies/runner.ts";

startSymphonies(config).catch((error: Error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
