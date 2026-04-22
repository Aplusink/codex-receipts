// Configuration file types

export interface ReceiptConfig {
  version: string;
  customerName?: string;
  location?: string;
  timezone?: string;
  printer?: string;
  codexInputUsdPerMillion?: number;
  codexCachedInputUsdPerMillion?: number;
  codexOutputUsdPerMillion?: number;
  notionApiKey?: string;
  notionPageId?: string;
  notionDatabaseId?: string;
  notionDataSourceId?: string;
  notionUpload?: boolean;
}

export const DEFAULT_CONFIG: ReceiptConfig = {
  version: "1.0.0",
};
