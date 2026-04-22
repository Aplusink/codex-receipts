import chalk from "chalk";
import { ConfigManager } from "../core/config-manager.js";
import type { ReceiptConfig } from "../types/config.js";

export interface ConfigOptions {
  show?: boolean;
  set?: string;
  reset?: boolean;
}

export class ConfigCommand {
  private configManager = new ConfigManager();

  async execute(options: ConfigOptions): Promise<void> {
    try {
      // Show config
      if (options.show) {
        await this.showConfig();
        return;
      }

      // Reset config
      if (options.reset) {
        await this.resetConfig();
        return;
      }

      // Set config value
      if (options.set) {
        await this.setConfig(options.set);
        return;
      }

      // Default: show config
      await this.showConfig();
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red("An unknown error occurred"));
      }
      process.exit(1);
    }
  }

  /**
   * Display current configuration
   */
  private async showConfig(): Promise<void> {
    const config = await this.configManager.loadConfig();
    const configPath = this.configManager.getConfigPath();

    console.log(chalk.cyan.bold("\nCodex Receipts Configuration"));
    console.log(chalk.gray(`Location: ${configPath}\n`));

    this.printConfigItem("Version", config.version);
    this.printConfigItem("Customer", config.customerName || "(session id)");
    this.printConfigItem("Location", config.location || "(auto-detect)");
    this.printConfigItem("Timezone", config.timezone || "(system default)");
    this.printConfigItem("Printer", config.printer || "(not set)");
    this.printConfigItem(
      "Codex input $/M",
      String(config.codexInputUsdPerMillion ?? "(auto)"),
    );
    this.printConfigItem(
      "Codex cached $/M",
      String(config.codexCachedInputUsdPerMillion || "(auto)"),
    );
    this.printConfigItem(
      "Codex output $/M",
      String(config.codexOutputUsdPerMillion || "(auto)"),
    );
    this.printConfigItem(
      "Notion upload",
      config.notionUpload ? "enabled" : "disabled",
    );
    this.printConfigItem(
      "Notion page",
      config.notionPageId || "(not set)",
    );
    this.printConfigItem(
      "Notion database",
      config.notionDatabaseId || "(not set)",
    );
    this.printConfigItem(
      "Notion data source",
      config.notionDataSourceId || "(not set)",
    );
    this.printConfigItem(
      "Notion API key",
      config.notionApiKey ? "(configured)" : "(not set)",
    );

    console.log("");
  }

  /**
   * Set a configuration value
   */
  private async setConfig(setValue: string): Promise<void> {
    const [key, ...valueParts] = setValue.split("=");
    const value = valueParts.join("=").trim();

    if (!key || !value) {
      throw new Error("Invalid format. Use: --set key=value");
    }

    const trimmedKey = key.trim() as keyof ReceiptConfig;

    // Validate key
    const validKeys: (keyof ReceiptConfig)[] = [
      "location",
      "customerName",
      "timezone",
      "printer",
      "codexInputUsdPerMillion",
      "codexCachedInputUsdPerMillion",
      "codexOutputUsdPerMillion",
      "notionApiKey",
      "notionPageId",
      "notionDatabaseId",
      "notionDataSourceId",
      "notionUpload",
    ];

    if (!validKeys.includes(trimmedKey)) {
      throw new Error(
        `Invalid config key: ${trimmedKey}. Valid keys: ${validKeys.join(", ")}`,
      );
    }

    // Update config
    const numericKeys: (keyof ReceiptConfig)[] = [
      "codexInputUsdPerMillion",
      "codexCachedInputUsdPerMillion",
      "codexOutputUsdPerMillion",
    ];
    const booleanKeys: (keyof ReceiptConfig)[] = ["notionUpload"];
    const shouldUnset = value === "auto" || value === "default" || value === "unset";
    const parsedValue = shouldUnset
      ? undefined
      : booleanKeys.includes(trimmedKey)
      ? value === "true" || value === "yes" || value === "1" || value === "on"
      : numericKeys.includes(trimmedKey)
      ? Number.parseFloat(value)
      : value;

    if (
      !shouldUnset &&
      numericKeys.includes(trimmedKey) &&
      (!Number.isFinite(parsedValue as number) || (parsedValue as number) < 0)
    ) {
      throw new Error(`${trimmedKey} must be a non-negative number`);
    }

    await this.configManager.updateConfig(trimmedKey, parsedValue);

    const displayValue =
      trimmedKey === "notionApiKey" && parsedValue ? "(configured)" : parsedValue;
    console.log(chalk.green(`✓ Updated ${trimmedKey} = ${displayValue}`));
  }

  /**
   * Reset configuration to defaults
   */
  private async resetConfig(): Promise<void> {
    await this.configManager.resetConfig();
    console.log(chalk.green("✓ Configuration reset to defaults"));
  }

  /**
   * Print a config item
   */
  private printConfigItem(label: string, value: string): void {
    console.log(`  ${chalk.bold(label.padEnd(20))} ${value}`);
  }
}
