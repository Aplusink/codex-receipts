import { readFile } from "fs/promises";
import type { ReceiptConfig } from "../types/config.js";
import type { ReceiptData } from "./receipt-generator.js";
import { formatCurrency, formatDateTime } from "../utils/formatting.js";

const NOTION_VERSION = "2026-03-11";

interface FileUploadResponse {
  id: string;
  upload_url?: string;
  status?: string;
}

export class NotionUploader {
  async uploadReceiptImage(
    imagePath: string,
    receiptData: ReceiptData,
    config: ReceiptConfig,
  ): Promise<void> {
    const token = config.notionApiKey || process.env.NOTION_API_KEY;
    const pageId = config.notionPageId || process.env.NOTION_RECEIPTS_PAGE_ID;
    const databaseId =
      config.notionDatabaseId || process.env.NOTION_RECEIPTS_DATABASE_ID;
    const dataSourceId =
      config.notionDataSourceId || process.env.NOTION_RECEIPTS_DATA_SOURCE_ID;

    if (!config.notionUpload || !token || (!pageId && !databaseId && !dataSourceId)) {
      return;
    }

    const filename = `${receiptData.transcriptData.sessionSlug}.png`;
    const fileUpload = await this.createFileUpload(token, filename);
    if (!fileUpload.upload_url) {
      throw new Error("Notion did not return a file upload URL");
    }

    await this.sendFileUpload(token, fileUpload.upload_url, imagePath, filename);
    if (dataSourceId || databaseId) {
      await this.createDatabaseReceiptPage(
        token,
        dataSourceId || databaseId!,
        !!dataSourceId,
        fileUpload.id,
        receiptData,
      );
      return;
    }

    await this.appendImageBlock(token, pageId!, fileUpload.id, receiptData);
  }

  private async createFileUpload(
    token: string,
    filename: string,
  ): Promise<FileUploadResponse> {
    const response = await fetch("https://api.notion.com/v1/file_uploads", {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        filename,
        content_type: "image/png",
      }),
    });

    return this.parseResponse<FileUploadResponse>(response);
  }

  private async sendFileUpload(
    token: string,
    uploadUrl: string,
    imagePath: string,
    filename: string,
  ): Promise<void> {
    const buffer = await readFile(imagePath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "image/png" }), filename);

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: form,
    });

    await this.parseResponse<FileUploadResponse>(response);
  }

  private async appendImageBlock(
    token: string,
    pageId: string,
    fileUploadId: string,
    receiptData: ReceiptData,
  ): Promise<void> {
    const title = `Codex receipt - ${formatCurrency(receiptData.sessionData.totalCost)}`;
    const date = formatDateTime(
      receiptData.transcriptData.endTime,
      receiptData.config.timezone,
    );

    const response = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children`,
      {
        method: "PATCH",
        headers: this.jsonHeaders(token),
        body: JSON.stringify({
          children: [
            {
              type: "heading_3",
              heading_3: {
                rich_text: [{ type: "text", text: { content: title } }],
              },
            },
            {
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    text: {
                      content: `${date} · ${receiptData.sessionData.totalTokens.toLocaleString("en-US")} tokens`,
                    },
                  },
                ],
              },
            },
            {
              type: "image",
              image: {
                caption: [
                  {
                    type: "text",
                    text: { content: receiptData.transcriptData.sessionSlug },
                  },
                ],
                type: "file_upload",
                file_upload: {
                  id: fileUploadId,
                },
              },
            },
          ],
        }),
      },
    );

    await this.parseResponse(response);
  }

  private async createDatabaseReceiptPage(
    token: string,
    parentId: string,
    useDataSourceParent: boolean,
    fileUploadId: string,
    receiptData: ReceiptData,
  ): Promise<void> {
    const title = this.getReceiptTitle(receiptData);
    const date = formatDateTime(
      receiptData.transcriptData.endTime,
      receiptData.config.timezone,
    );

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        parent: useDataSourceParent
          ? { type: "data_source_id", data_source_id: parentId }
          : { database_id: parentId },
        properties: {
          Name: {
            title: [{ type: "text", text: { content: title } }],
          },
        },
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: `${date} · ${receiptData.sessionData.totalTokens.toLocaleString("en-US")} tokens`,
                  },
                },
              ],
            },
          },
          {
            type: "image",
            image: {
              caption: [
                {
                  type: "text",
                  text: { content: receiptData.transcriptData.sessionSlug },
                },
              ],
              type: "file_upload",
              file_upload: {
                id: fileUploadId,
              },
            },
          },
        ],
      }),
    });

    await this.parseResponse(response);
  }

  private getReceiptTitle(receiptData: ReceiptData): string {
    const date = formatDateTime(
      receiptData.transcriptData.endTime,
      receiptData.config.timezone,
    );
    return `Codex receipt ${date} ${formatCurrency(receiptData.sessionData.totalCost)}`;
  }

  private jsonHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    };
  }

  private async parseResponse<T = unknown>(response: Response): Promise<T> {
    const body = await response.text();
    const parsed = body ? JSON.parse(body) : {};

    if (!response.ok) {
      const message =
        parsed.message || parsed.error || `Notion API error ${response.status}`;
      throw new Error(message);
    }

    return parsed as T;
  }
}
