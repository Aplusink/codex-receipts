#!/usr/bin/env node

import { Command, Option } from "commander";
import { GenerateCommand } from "./commands/generate.js";
import { ConfigCommand } from "./commands/config.js";
import { SetupCommand } from "./commands/setup.js";
import { WatchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("codex-receipts")
  .description("Generate receipt-style summaries for local Codex sessions")
  .version("1.1.0");

// Generate command
program
  .command("generate")
  .description("Generate a receipt for a Codex session")
  .option("-s, --session <id>", "Specific session ID to generate receipt for")
  .addOption(
    new Option("-o, --output <format...>", "Output format(s): html, console, printer (comma-separated or repeated)")
      .argParser((value: string, prev: string[] | undefined) => {
        const formats = value.split(",").map((s) => s.trim()).filter(Boolean);
        const valid = ["html", "console", "printer"];
        for (const f of formats) {
          if (!valid.includes(f)) {
            throw new Error(`Invalid output format "${f}". Valid formats: ${valid.join(", ")}`);
          }
        }
        return [...(prev || []), ...formats];
      }),
  )
  .option("-l, --location <text>", "Override location detection")
  .option("--open", "Open HTML output in Google Chrome after generation")
  .addOption(new Option("--source <source>", "Session source").choices(["codex"]))
  .option(
    "-p, --printer <interface>",
    'Printer: "usb" (auto-detect), "usb:VID:PID", "tcp://host:port", or CUPS name',
  )
  .action(async (options) => {
    const command = new GenerateCommand();
    await command.execute(options);
  });

// Config command
program
  .command("config")
  .description("Manage configuration")
  .option("--show", "Display current configuration")
  .option("--set <key=value>", "Set a configuration value")
  .option("--reset", "Reset configuration to defaults")
  .action(async (options) => {
    const command = new ConfigCommand();
    await command.execute(options);
  });

// Setup command
program
  .command("setup")
  .description("Setup automatic receipt generation")
  .option("--codex-watch", "Install the Codex receipts LaunchAgent watcher")
  .option("--uninstall-codex-watch", "Remove the Codex receipts LaunchAgent watcher")
  .action(async (options) => {
    const command = new SetupCommand();
    await command.execute(options);
  });

// Watch command
program
  .command("watch")
  .description("Watch Codex sessions and generate receipts after they go idle")
  .option("--idle-seconds <seconds>", "Seconds since last update before printing", "300")
  .option("--interval-seconds <seconds>", "Polling interval", "30")
  .option("--once", "Run one check and exit")
  .option("--only-when-codex-closed", "Only generate when Codex is not running")
  .addOption(
    new Option("-o, --output <format...>", "Output format(s): html, console, printer")
      .argParser((value: string, prev: string[] | undefined) => {
        const formats = value.split(",").map((s) => s.trim()).filter(Boolean);
        const valid = ["html", "console", "printer"];
        for (const f of formats) {
          if (!valid.includes(f)) {
            throw new Error(`Invalid output format "${f}". Valid formats: ${valid.join(", ")}`);
          }
        }
        return [...(prev || []), ...formats];
      }),
  )
  .option("-l, --location <text>", "Override location detection")
  .option("-p, --printer <interface>", "Printer interface")
  .action(async (options) => {
    const command = new WatchCommand();
    await command.execute(options);
  });

// Make generate the default command if no command is specified
if (process.argv.length === 2) {
  process.argv.push("generate");
}

program.parse();
