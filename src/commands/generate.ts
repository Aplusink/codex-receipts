import chalk from "chalk";
import boxen from "boxen";
import ora from "ora";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { CodexDataFetcher } from "../core/codex-data-fetcher.js";
import { TranscriptParser } from "../core/transcript-parser.js";
import { ReceiptGenerator } from "../core/receipt-generator.js";
import { HtmlRenderer } from "../core/html-renderer.js";
import { ThermalPrinterRenderer } from "../core/thermal-printer.js";
import { ReceiptImageRenderer } from "../core/receipt-image-renderer.js";
import { NotionUploader } from "../core/notion-uploader.js";
import { ConfigManager } from "../core/config-manager.js";
import { LocationDetector } from "../utils/location.js";
import type { ReceiptData } from "../core/receipt-generator.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type OutputFormat = "html" | "console" | "printer";

export interface GenerateOptions {
  session?: string;
  output?: string[];
  location?: string;
  printer?: string;
  source?: "codex";
  openBrowser?: boolean;
  open?: boolean;
}

export class GenerateCommand {
  private codexDataFetcher = new CodexDataFetcher();
  private transcriptParser = new TranscriptParser();
  private receiptGenerator = new ReceiptGenerator();
  private htmlRenderer = new HtmlRenderer();
  private thermalPrinter = new ThermalPrinterRenderer();
  private imageRenderer = new ReceiptImageRenderer();
  private notionUploader = new NotionUploader();
  private configManager = new ConfigManager();
  private locationDetector = new LocationDetector();

  async execute(options: GenerateOptions): Promise<void> {
    const spinner = ora("Generating receipt...").start();

    try {
      const config = await this.configManager.loadConfig();

      spinner.text = "Fetching session data...";
      const sessionData = await this.codexDataFetcher.fetchSessionData(
        options.session,
        config,
      );

      if (!sessionData.projectPath) {
        throw new Error(
          "Cannot determine transcript path. Session has no valid project path.",
        );
      }

      spinner.text = "Parsing transcript...";
      const transcriptData =
        await this.transcriptParser.parseTranscript(sessionData.projectPath);

      const location =
        options.location || (await this.locationDetector.getLocation(config));

      spinner.text = "Generating receipt...";
      const receiptData = {
        sessionData,
        transcriptData,
        location,
        config,
      };

      const receipt = this.receiptGenerator.generateReceipt(receiptData);

      spinner.succeed("Receipt generated!");

      const outputFormats = [
        ...new Set(options.output || ["console"]),
      ] as OutputFormat[];

      const errors: Array<{ format: OutputFormat; error: Error }> = [];

      for (const format of outputFormats) {
        try {
          switch (format) {
            case "printer":
              await this.outputToPrinter(receiptData, options, config, spinner);
              break;
            case "html":
              await this.outputToHtml(
                receiptData,
                receipt,
                options.session || sessionData.sessionId,
                transcriptData.sessionSlug,
                !!options.openBrowser || !!options.open,
                config,
              );
              break;
            case "console":
              this.outputToConsole(receipt);
              break;
          }
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error("Unknown error");
          errors.push({ format, error });

          if (outputFormats.length > 1) {
            console.log(
              chalk.yellow(
                `\n⚠ ${format} output failed: ${error.message}`,
              ),
            );
          }
        }
      }

      if (errors.length === outputFormats.length) {
        // All outputs failed — throw the first error
        throw errors[0].error;
      }
    } catch (error) {
      spinner.fail("Failed to generate receipt");

      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red("An unknown error occurred"));
      }

      process.exit(1);
    }
  }

  /**
   * Send receipt to thermal printer
   */
  private async outputToPrinter(
    receiptData: ReceiptData,
    options: GenerateOptions,
    config: { printer?: string },
    spinner: ReturnType<typeof ora>,
  ): Promise<void> {
    const printerInterface = options.printer || config.printer;
    if (!printerInterface) {
      throw new Error(
        'No printer specified. Use --printer <name> or set via: codex-receipts config --set printer=EPSON_TM_T88V',
      );
    }

    spinner.start("Sending to printer...");
    await this.thermalPrinter.printReceipt(receiptData, printerInterface);
    spinner.succeed(`Receipt sent to printer: ${printerInterface}`);
  }

  /**
   * Save receipt as HTML and optionally open in browser
   */
  private async outputToHtml(
    receiptData: ReceiptData,
    receipt: string,
    sessionId: string,
    sessionSlug: string | undefined,
    isFromHook: boolean,
    config: { notionUpload?: boolean },
  ): Promise<void> {
    const fileName = sessionSlug || sessionId;
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const outputDir = `${home}/.codex-receipts/projects`;
    const fullPath = `${outputDir}/${fileName}.html`;

    const html = this.htmlRenderer.generateHtml(receiptData, receipt);
    await this.saveHtmlFile(html, fullPath);

    if (config.notionUpload) {
      const pngPath = `${outputDir}/${fileName}.png`;
      await this.imageRenderer.renderHtmlToPng(fullPath, pngPath);
      await this.notionUploader.uploadReceiptImage(
        pngPath,
        receiptData,
        receiptData.config,
      );
      console.log(chalk.green(`Receipt uploaded to Notion as image`));
    }

    if (isFromHook) {
      await this.openInBrowser(fullPath);
    } else {
      console.log(chalk.cyan("\nTip: Open in browser to view!"));
    }
  }

  /**
   * Display receipt to console with formatting
   */
  private outputToConsole(receipt: string): void {
    this.displayToConsole(receipt);
  }

  /**
   * Display receipt to console with formatting
   */
  private displayToConsole(receipt: string): void {
    console.log(
      boxen(receipt, {
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: "cyan",
      }),
    );
  }

  /**
   * Save receipt to a file
   */
  /**
   * Save HTML file
   */
  private async saveHtmlFile(html: string, outputPath: string): Promise<void> {
    const { writeFile, mkdir } = await import("fs/promises");
    const { dirname, resolve } = await import("path");

    const resolvedPath = resolve(this.expandPath(outputPath));
    const dir = dirname(resolvedPath);

    // Ensure directory exists
    await mkdir(dir, { recursive: true });

    // Write HTML to file
    await writeFile(resolvedPath, html, "utf-8");

    console.log(chalk.green(`Receipt saved to: ${resolvedPath}`));
  }

  /**
   * Open file in a browser. On macOS, prefer Google Chrome.
   */
  private async openInBrowser(filePath: string): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === "darwin") {
        try {
          await execFileAsync("open", ["-a", "Google Chrome", filePath]);
        } catch {
          await execFileAsync("open", [filePath]);
        }
      } else if (platform === "win32") {
        // Windows
        await execAsync(`start "" "${filePath}"`);
      } else {
        // Linux
        await execAsync(`xdg-open "${filePath}"`);
      }
    } catch (error) {
      // Silently fail - file is still saved
      // Can't log error in hook context anyway
    }
  }

  /**
   * Expand ~ to home directory
   */
  private expandPath(path: string): string {
    if (path.startsWith("~/")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      return path.replace(/^~/, home);
    }
    return path;
  }
}
