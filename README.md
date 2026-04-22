# Codex Receipts

Thermal-printer style receipts for local Codex sessions.

Codex Receipts reads local Codex session metadata, estimates token spend,
renders a receipt as HTML/PNG, opens it in Chrome, and can archive the PNG
receipt into Notion.

## Features

- Generate receipt-style summaries for recent Codex sessions
- Automatic macOS LaunchAgent trigger after the Codex app closes
- HTML, console, and ESC/POS thermal-printer output
- PNG export for receipt-only images, without the browser background
- Optional Notion archive: each generated receipt can be uploaded as a PNG image
  into a Notion database
- No personal configuration, Notion tokens, generated receipts, or local Codex
  data are stored in this repository

## Install Locally

```bash
npm install
npm run build
```

Generate the most recent Codex receipt:

```bash
node bin/codex-receipts.js generate --output html --open
```

## Automatic Generation

This project uses a low-memory macOS LaunchAgent. The LaunchAgent wakes up
every 60 seconds, exits immediately while Codex is running, and generates a
receipt only after Codex has closed and the latest session is idle.

Install the LaunchAgent:

```bash
node bin/codex-receipts.js setup --codex-watch
```

Remove it:

```bash
node bin/codex-receipts.js setup --uninstall-codex-watch
```

Run one foreground check:

```bash
node bin/codex-receipts.js watch --once --only-when-codex-closed
```

## Configuration

Configuration is stored outside the repo:

```text
~/.codex-receipts.config.json
```

Show config:

```bash
node bin/codex-receipts.js config --show
```

Common settings:

```bash
node bin/codex-receipts.js config --set customerName="Your Name"
node bin/codex-receipts.js config --set location=auto
node bin/codex-receipts.js config --set timezone="America/New_York"
```

Optional Codex cost overrides:

```bash
node bin/codex-receipts.js config --set codexInputUsdPerMillion=2.5
node bin/codex-receipts.js config --set codexCachedInputUsdPerMillion=0.25
node bin/codex-receipts.js config --set codexOutputUsdPerMillion=15
```

## Notion Archive

To archive PNG receipts into Notion:

1. Create a Notion integration.
2. Share the target database with that integration.
3. Configure the local token and target data source.

```bash
node bin/codex-receipts.js config --set notionApiKey="<notion-integration-token>"
node bin/codex-receipts.js config --set notionDataSourceId="<notion-data-source-id>"
node bin/codex-receipts.js config --set notionUpload=true
```

The token is stored only in your local config file and should never be committed.

## Outputs

HTML and PNG receipts are written to:

```text
~/.codex-receipts/projects/
```

Watcher logs are written to:

```text
~/.codex-receipts/logs/
```

## Privacy Notes

Before publishing or forking, keep these out of git:

- `~/.codex-receipts.config.json`
- `~/.codex-receipts/projects/`
- `~/.codex-receipts/logs/`
- `~/.codex/`
- Notion integration tokens and other API keys

## License

MIT
