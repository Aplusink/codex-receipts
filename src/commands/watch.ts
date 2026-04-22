import chalk from "chalk";
import ora from "ora";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { GenerateCommand } from "./generate.js";
import { CodexDataFetcher } from "../core/codex-data-fetcher.js";

const execFileAsync = promisify(execFile);

export interface WatchOptions {
  idleSeconds?: string;
  intervalSeconds?: string;
  once?: boolean;
  onlyWhenCodexClosed?: boolean;
  output?: string[];
  printer?: string;
  location?: string;
}

interface WatchState {
  printedThreadIds: string[];
}

export class WatchCommand {
  private dataFetcher = new CodexDataFetcher();
  private generateCommand = new GenerateCommand();
  private statePath: string;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    this.statePath = join(home, ".codex-receipts", "codex-watch-state.json");
  }

  async execute(options: WatchOptions): Promise<void> {
    const idleSeconds = this.parsePositiveInt(options.idleSeconds, 300);
    const intervalSeconds = this.parsePositiveInt(options.intervalSeconds, 30);

    console.log(chalk.cyan.bold("\nCodex Receipts Watcher\n"));
    console.log(
      chalk.gray(
        `Watching Codex sessions. Idle threshold: ${idleSeconds}s, interval: ${intervalSeconds}s${
          options.onlyWhenCodexClosed ? ", only when Codex is closed" : ""
        }\n`,
      ),
    );

    if (options.once) {
      await this.checkOnce(options, idleSeconds);
      return;
    }

    await this.checkOnce(options, idleSeconds);
    setInterval(() => {
      this.checkOnce(options, idleSeconds).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Watcher error: ${message}`));
      });
    }, intervalSeconds * 1000);
  }

  private async checkOnce(
    options: WatchOptions,
    idleSeconds: number,
  ): Promise<void> {
    if (options.onlyWhenCodexClosed && (await this.isCodexRunning())) {
      return;
    }

    const firstRun = !existsSync(this.statePath);
    const state = await this.loadState();
    const printed = new Set(state.printedThreadIds);
    const threads = await this.dataFetcher.listThreads(25);
    const now = Date.now();
    let changed = false;

    for (const thread of threads) {
      if (printed.has(thread.id)) continue;

      const idleMs = now - thread.updatedAt.getTime();
      if (idleMs < idleSeconds * 1000) continue;

      if (firstRun) {
        printed.add(thread.id);
        changed = true;
        continue;
      }

      const spinner = ora(`Generating receipt for ${thread.title}`).start();
      try {
        await this.generateCommand.execute({
          session: thread.id,
          source: "codex",
          output: options.output || ["html"],
          printer: options.printer,
          location: options.location,
          openBrowser: true,
        });

        printed.add(thread.id);
        changed = true;
        spinner.succeed(`Generated receipt for ${thread.title}`);
      } catch (error) {
        spinner.fail(`Failed to generate receipt for ${thread.title}`);
        throw error;
      }
    }

    if (changed || firstRun) {
      await this.saveState({ printedThreadIds: [...printed].slice(-500) });
    }
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async loadState(): Promise<WatchState> {
    if (!existsSync(this.statePath)) {
      return { printedThreadIds: [] };
    }

    try {
      const content = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<WatchState>;
      return {
        printedThreadIds: Array.isArray(parsed.printedThreadIds)
          ? parsed.printedThreadIds
          : [],
      };
    } catch {
      return { printedThreadIds: [] };
    }
  }

  private async saveState(state: WatchState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private async isCodexRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("pgrep", [
        "-fil",
        "/Applications/Codex.app",
      ]);

      return stdout
        .split("\n")
        .some((line) => line.trim().includes("/Applications/Codex.app"));
    } catch {
      return false;
    }
  }
}
