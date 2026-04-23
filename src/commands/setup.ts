import { writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import ora from "ora";

const execFileAsync = promisify(execFile);

export interface SetupOptions {
  codexWatch?: boolean;
  uninstallCodexWatch?: boolean;
}

export class SetupCommand {
  async execute(options: SetupOptions): Promise<void> {
    console.log(chalk.cyan.bold("\nCodex Receipts Setup\n"));

    try {
      if (options.uninstallCodexWatch) {
        await this.uninstallCodexWatcher();
      } else {
        await this.installCodexWatcher();
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\nError: ${error.message}`));
      } else {
        console.error(chalk.red("\nAn unknown error occurred"));
      }
      process.exit(1);
    }
  }

  private async installCodexWatcher(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("Codex watcher setup currently supports macOS LaunchAgents only.");
    }

    const spinner = ora("Installing Codex watcher LaunchAgent...").start();
    const plistPath = this.getCodexWatcherPlistPath();
    const nodePath = process.execPath;
    const cliPath = resolve(process.argv[1] || "bin/codex-receipts.js");
    const logDir = join(process.env.HOME || "", ".codex-receipts", "logs");

    try {
      await mkdir(dirname(plistPath), { recursive: true });
      await mkdir(logDir, { recursive: true });

      const plist = this.buildCodexWatcherPlist({
        nodePath,
        cliPath,
        intervalSeconds: 60,
        stdoutPath: join(logDir, "codex-watch.out.log"),
        stderrPath: join(logDir, "codex-watch.err.log"),
      });

      await writeFile(plistPath, plist, "utf-8");

      await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.()}`, plistPath]).catch(() => undefined);
      await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, plistPath]);
      await execFileAsync("launchctl", ["enable", `gui/${process.getuid?.()}/dev.codex-receipts.watch`]);

      spinner.succeed("Codex watcher installed");
      console.log(chalk.green("\n✓ Codex receipts will be generated after Codex closes"));
      console.log(chalk.gray(`  LaunchAgent: ${plistPath}`));
      console.log(chalk.gray(`  Logs: ${logDir}\n`));
    } catch (error) {
      spinner.fail("Codex watcher setup failed");
      throw error;
    }
  }

  private async uninstallCodexWatcher(): Promise<void> {
    const spinner = ora("Removing Codex watcher LaunchAgent...").start();
    const plistPath = this.getCodexWatcherPlistPath();

    try {
      await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.()}`, plistPath]).catch(() => undefined);
      if (existsSync(plistPath)) {
        await unlink(plistPath);
      }

      spinner.succeed("Codex watcher removed");
      console.log(chalk.green("\n✓ Codex watcher uninstalled\n"));
    } catch (error) {
      spinner.fail("Codex watcher uninstall failed");
      throw error;
    }
  }

  private getCodexWatcherPlistPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return join(home, "Library", "LaunchAgents", "dev.codex-receipts.watch.plist");
  }

  private buildCodexWatcherPlist(options: {
    nodePath: string;
    cliPath: string;
    intervalSeconds: number;
    stdoutPath: string;
    stderrPath: string;
  }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.codex-receipts.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.escapePlist(options.nodePath)}</string>
    <string>${this.escapePlist(options.cliPath)}</string>
    <string>watch</string>
    <string>--once</string>
    <string>--only-when-codex-closed</string>
    <string>--idle-seconds</string>
    <string>10</string>
    <string>--output</string>
    <string>html</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${options.intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${this.escapePlist(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${this.escapePlist(options.stderrPath)}</string>
</dict>
</plist>
`;
  }

  private escapePlist(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }
}
