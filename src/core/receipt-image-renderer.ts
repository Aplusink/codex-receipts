import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class ReceiptImageRenderer {
  async renderHtmlToPng(htmlPath: string, pngPath: string): Promise<string> {
    await mkdir(dirname(pngPath), { recursive: true });

    const chromePath = await this.findChromePath();
    if (!chromePath) {
      throw new Error("Google Chrome not found. Cannot render receipt PNG.");
    }

    const exportHtmlPath = await this.createExportHtml(htmlPath);

    try {
      await execFileAsync(chromePath, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=470,900",
        `--screenshot=${pngPath}`,
        `file://${exportHtmlPath}`,
      ]);
    } finally {
      await unlink(exportHtmlPath).catch(() => undefined);
    }

    return pngPath;
  }

  private async createExportHtml(htmlPath: string): Promise<string> {
    const html = await readFile(htmlPath, "utf-8");
    const exportHtml = html.replace(
      "</style>",
      `
    body {
      background: #ffffff !important;
      min-height: auto !important;
      align-items: flex-start !important;
      justify-content: flex-start !important;
      padding: 20px !important;
      width: max-content !important;
    }
    .receipt-container {
      display: block !important;
      gap: 0 !important;
    }
    .receipt {
      animation: none !important;
      box-shadow: none !important;
      margin: 15px 10px !important;
    }
    .share-section,
    script,
    #receipt-data {
      display: none !important;
    }
  </style>`,
    );
    const exportHtmlPath = htmlPath.replace(/\.html$/, ".export.html");
    await writeFile(exportHtmlPath, exportHtml, "utf-8");
    return exportHtmlPath;
  }

  private async findChromePath(): Promise<string | null> {
    const candidates =
      process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : ["google-chrome", "chromium", "chromium-browser"];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ["--version"]);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }

    return null;
  }
}
