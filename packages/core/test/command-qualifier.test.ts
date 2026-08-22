import { describe, expect, it } from "vitest";
import { commandQualificationSchema, qualifyCommand } from "../src/index.js";

describe("qualifyCommand", () => {
  it.each([
    ["npm install lodash", "npm", "lodash", "latest"],
    ["npm i lodash@4.17.21", "npm", "lodash", "4.17.21"],
    ["npm add lodash@next", "npm", "lodash", "next"],
    ["pnpm add lodash@^4.17.0", "pnpm", "lodash", "^4.17.0"],
    ["pnpm add @scope/package@1.2.3-beta.1", "pnpm", "@scope/package", "1.2.3-beta.1"],
    ["  npm   add   lodash@~4.17.0  ", "npm", "lodash", "~4.17.0"],
  ])(
    "recognizes direct registry dependency addition %s",
    (command, manager, name, requestedSpec) => {
      expect(qualifyCommand(command)).toMatchObject({
        category: "dependency_add",
        manager,
        operation: "add",
        packages: [{ name, requestedSpec }],
      });
    },
  );

  it("preserves deterministic operand order and accepts exactly eight", () => {
    const packages = Array.from({ length: 8 }, (_, index) => `package-${index}`);
    const result = qualifyCommand(`npm add ${packages.join(" ")}`);
    expect(result).toMatchObject({
      category: "dependency_add",
      packages: packages.map((name) => ({ name })),
    });
  });

  it.each([
    ["git status", "unrelated", "not_dependency_action"],
    ["echo npm-package", "unrelated", "not_dependency_action"],
    ["echo café", "unrelated", "not_dependency_action"],
    ["echo npm", "unrelated", "not_dependency_action"],
    ["git commit -m npm", "unrelated", "not_dependency_action"],
    ["printf yarn", "unrelated", "not_dependency_action"],
    ["npx cowsay", "ephemeral_execution", "ephemeral_execution_unsupported"],
    ["npm exec eslint", "ephemeral_execution", "ephemeral_execution_unsupported"],
    ["npm x eslint", "ephemeral_execution", "ephemeral_execution_unsupported"],
    ["pnpm dlx eslint", "ephemeral_execution", "ephemeral_execution_unsupported"],
    ["pnpm exec eslint", "ephemeral_execution", "ephemeral_execution_unsupported"],
    ["pnpx eslint", "ephemeral_execution", "ephemeral_execution_unsupported"],
  ])("classifies %s without claiming dependency evaluation", (command, category, reasonCode) => {
    expect(qualifyCommand(command)).toEqual({ category, reasonCode });
  });

  it.each([
    ["npm add", "no_operands"],
    ["npm ci", "unsupported_subcommand"],
    ["npm run install", "unsupported_subcommand"],
    ["pnpm install lodash", "unsupported_subcommand"],
    ["npm add -D lodash", "unsupported_flag"],
    ["npm add lodash --save-dev", "unsupported_flag"],
    ["npm add -- lodash", "double_dash"],
    ["npm add package@workspace:*", "workspace_operand"],
    ["npm add package@file:../package", "non_registry_operand"],
    ["npm add package@https://example.test/p.tgz", "non_registry_operand"],
    ["npm add owner/repository#main", "non_registry_operand"],
    ["npm add 'lodash'", "shell_composition"],
    ['npm add "lodash"', "shell_composition"],
    ["npm add lodash && echo done", "shell_composition"],
    ["npm add lodash | tee out", "shell_composition"],
    ["npm add $(echo lodash)", "shell_composition"],
    ["NPM add lodash", "unsupported_executable"],
    ["npm ADD lodash", "unsupported_subcommand"],
    ["/usr/bin/npm add lodash", "unsupported_package_manager"],
    ["npm.cmd add lodash", "unsupported_package_manager"],
    ["corepack npm add lodash", "unsupported_package_manager"],
    ["sudo npm add lodash", "unsupported_package_manager"],
    ["bash -c 'npm add lodash'", "unsupported_package_manager"],
    ["bash -c 'npm exec eslint'", "unsupported_package_manager"],
    ["n\\pm add lodash", "unsupported_package_manager"],
    ["'n'pm add lodash", "unsupported_package_manager"],
    ['n""pm add lodash', "unsupported_package_manager"],
    ["n{p,}m add lodash", "unsupported_package_manager"],
    ["$NPM add lodash", "unsupported_package_manager"],
    ["$(printf npm) add lodash", "shell_composition"],
    ["/usr/bin/n?m add lodash", "shell_composition"],
    ["n*m add lodash", "shell_composition"],
    ["echo ok; npm add lodash", "shell_composition"],
    ["echo ok; n\\pm add lodash", "shell_composition"],
    ["echo $(npm add lodash)", "shell_composition"],
    ["echo `npm add lodash`", "shell_composition"],
    ["! npm add lodash", "unsupported_package_manager"],
    ["/usr/bin/env npm add lodash", "unsupported_package_manager"],
    ["/usr/bin/sudo npm add lodash", "unsupported_package_manager"],
    ["timeout 5 npm add lodash", "unsupported_package_manager"],
    ["setsid npm add lodash", "unsupported_package_manager"],
    ["if npm add lodash; then echo ok; fi", "unsupported_package_manager"],
    ["dash -c 'npm add lodash'", "unsupported_package_manager"],
    ["ksh -c 'npm add lodash'", "unsupported_package_manager"],
    ["busybox sh -c 'npm add lodash'", "unsupported_package_manager"],
    ["env FOO=npm git status", "unsupported_package_manager"],
    ["PATH+=:/tmp npm add lodash", "unsupported_package_manager"],
    ["FOO+=bar pnpm add zod", "unsupported_package_manager"],
    ["coproc npm add lodash", "unsupported_package_manager"],
    ["coproc pnpm add zod", "unsupported_package_manager"],
    ["doas npm add lodash", "unsupported_package_manager"],
    ["chroot /tmp npm add lodash", "unsupported_package_manager"],
    ["runuser -u nobody -- npm add lodash", "unsupported_package_manager"],
    ["stdbuf -oL npm add lodash", "unsupported_package_manager"],
    ["taskset -c 0 npm add lodash", "unsupported_package_manager"],
    ["ionice npm add lodash", "unsupported_package_manager"],
    ["strace npm add lodash", "unsupported_package_manager"],
    ["watch npm add lodash", "unsupported_package_manager"],
    ["for item in one; do npm add lodash; done", "unsupported_package_manager"],
    ["git status # comment", "shell_composition"],
    ["sudo echo npm", "unsupported_package_manager"],
    ["node print.js npm", "unsupported_package_manager"],
    ["python script.py pnpm", "unsupported_package_manager"],
    ["bash -c 'echo npm'", "unsupported_package_manager"],
    ["env -S npm add lodash", "unsupported_package_manager"],
    ["env --split-string npm add lodash", "unsupported_package_manager"],
    ["nice -n 5 npm add lodash", "unsupported_package_manager"],
    ["xargs -n 1 npm add lodash", "unsupported_package_manager"],
    ["time -f fmt npm add lodash", "unsupported_package_manager"],
    ["bash -lc 'npm add lodash'", "unsupported_package_manager"],
    ["sh -ec 'npm add lodash'", "unsupported_package_manager"],
    ["node --eval \"execSync('npm add lodash')\"", "unsupported_package_manager"],
    ["echo $(echo $(npm add lodash))", "shell_composition"],
    ["cat <(npm add lodash)", "shell_composition"],
    ["case x in x) npm add lodash;; esac", "unsupported_package_manager"],
    ["busybox env npm add lodash", "unsupported_package_manager"],
    ["node -e \"console.log('npm add lodash')\"", "unsupported_package_manager"],
    ["git status && git diff", "shell_composition"],
    ['git commit -m "hello"', "shell_composition"],
    [
      "n*m --location=global --ignore-scripts --foreground-scripts install lodash",
      "shell_composition",
    ],
    ["corepack pnpm dlx eslint", "unsupported_package_manager"],
    ["eval 'npm add lodash'", "unsupported_package_manager"],
    ["node -e \"execSync('npm add lodash')\"", "unsupported_package_manager"],
    ["npx.cmd eslint", "unsupported_package_manager"],
    ["yarn add lodash", "unsupported_package_manager"],
    ["bun add lodash", "unsupported_package_manager"],
  ])("denies unsupported install-like shape %s", (command, reasonCode) => {
    expect(qualifyCommand(command)).toEqual({ category: "install_like_unsupported", reasonCode });
  });

  it.each([
    ["", "command_empty"],
    ["   ", "command_empty"],
    ["npm\tadd lodash", "control_character"],
    ["npm add lodash\nnpm add zod", "control_character"],
    ["npm\u00a0add lodash", "control_character"],
    ["npm add lod\u200bash", "control_character"],
    ["npm add UPPERCASE", "invalid_operand"],
    [`npm add ${Array.from({ length: 9 }, (_, index) => `p-${index}`).join(" ")}`, "operand_limit"],
    ["x".repeat(16_385), "command_limit"],
    ["é".repeat(8193), "command_limit"],
  ])("rejects invalid input without throwing %j", (command, reasonCode) => {
    expect(qualifyCommand(command)).toEqual({ category: "invalid", reasonCode });
  });

  it("does not apply POSIX qualification to another shell dialect", () => {
    expect(qualifyCommand("npm add lodash", "powershell")).toEqual({
      category: "install_like_unsupported",
      reasonCode: "shell_dialect_unsupported",
    });
    expect(qualifyCommand("Get-ChildItem", "powershell")).toEqual({
      category: "install_like_unsupported",
      reasonCode: "shell_dialect_unsupported",
    });
    expect(qualifyCommand("Write-Output npm", "powershell")).toEqual({
      category: "install_like_unsupported",
      reasonCode: "shell_dialect_unsupported",
    });
    expect(qualifyCommand("npm.cmd add lodash", "powershell")).toEqual({
      category: "install_like_unsupported",
      reasonCode: "shell_dialect_unsupported",
    });
    expect(qualifyCommand("Start-Process npm -ArgumentList add,lodash", "powershell")).toEqual({
      category: "install_like_unsupported",
      reasonCode: "shell_dialect_unsupported",
    });
  });

  it("accepts exactly 16384 UTF-8 command bytes", () => {
    expect(qualifyCommand("é".repeat(8192))).toEqual({
      category: "unrelated",
      reasonCode: "not_dependency_action",
    });
  });

  it("always emits a strict bounded qualification without the raw command", () => {
    const command = "npm add lodash zod@4.4.3";
    const result = commandQualificationSchema.parse(qualifyCommand(command));
    expect(JSON.stringify(result)).not.toContain(command);
    expect(() => commandQualificationSchema.parse({ ...result, command })).toThrow();
  });
});
