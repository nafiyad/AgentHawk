#!/usr/bin/env node

import { createProgram } from "./program.js";
import { runCli } from "./runner.js";

await runCli(process.argv);

export { createProgram, runCli };
