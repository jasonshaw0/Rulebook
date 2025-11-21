# Rulebook - Agent Rule Manager

Rulebook is a Visual Studio Code / Cursor extension for managing `.cursorrules` in a structured, IDE-native way.

## Overview

Rulebook adds a dedicated icon to the Activity Bar and a sidebar view that lets you manage three kinds of rules:

- **User Rules** – Global rules that apply across all workspaces (written to `~/.cursorrules`).
- **Project Rules** – Rules scoped to the current workspace (written to `<workspace>/.cursorrules`).
- **Presets** – Saved rules that are not currently applied, but can be copied or re-scoped later.

Rules live as plain Markdown files on disk and are grouped in the UI based on simple header syntax inside each file.

## Current Features

- **Activity Bar integration** – A dedicated icon and “Agent Rules” view in the sidebar.
- **Explorer-style sections** – Collapsible **User**, **Project**, and **Presets** sections with toolbar-style “+” buttons.
- **Rule creation** – Clicking **Add**:
  - Prompts for a rule title.
  - Creates a new Markdown file in the appropriate folder.
  - Pre-fills it with metadata used by the sidebar and `.cursorrules` generator:
    ```text
    # @agent-rule
    # title: My rule title
    # scope: user|project|preset

    Describe the rule here. This content will be included in your .cursorrules files.
    ```
  - Opens the new rule in the main editor.
- **Rule editing** – Rules appear in a list; hovering shows edit/delete icons and double‑click opens the file.
- **Scope & title via syntax** – Changing `# title:` updates the list label; changing `# scope:` moves the rule between User / Project / Presets.
- **Automatic `.cursorrules` generation** –
  - All `scope: user` rules are concatenated into `~/.cursorrules`.
  - All `scope: project` rules are concatenated into `<workspace>/.cursorrules`.
  - `scope: preset` rules are excluded from `.cursorrules` (they’re just templates).

## Requirements

- Visual Studio Code `1.80.0` or higher (or Cursor with VS Code extension support).
- Node.js (for local development and packaging).

## Installation (local dev)

1. Clone or create this repository:
   ```bash
   git clone https://github.com/your-username/rulebook-agent-rule-manager.git
   cd rulebook-agent-rule-manager
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run compile
   ```
3. Package the extension:
   ```bash
   vsce package
   ```
4. In VS Code or Cursor, install the generated `.vsix` via **Extensions → Install from VSIX…**.

## Usage

1. Click the **Rulebook / Agent Rules** icon in the Activity Bar.
2. Use the **Add** button in any section to create new rules.
3. Edit the generated rule files to refine behavior, change titles, or move rules between scopes by updating the header.

## License

MIT – see `LICENSE` for details.


