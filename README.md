## Rulebook – System Instruction Manager

#### Rulebook is an IDE extension that makes accessing, managing, and discovering system instructions effortless, elevating agent-assisted development to the next level.

  <table>
    <tr>
      <td>
        <h4><i>It's not magic, it's markdown!</i></h4>
      </td>
      <td>
        <img src="./media/rulebook-logo-nobg-blue.png" alt="Rulebook logo" width="25%" style="vertical-align: middle; margin-left:0px;" />
      </td>
    </tr>
  </table>


stored in `.cursor/rules`. It is designed to stay out of your way while keeping your rules organized. Today it runs in Cursor, with VS Code support planned next.


### Features

- Clean and simple sidebar interface in your editor (currently Cursor), accessible with a single icon click.
- Works directly with `.cursor/rules` using the same MDC metadata (`description`, `scope`, `globs`, `alwaysApply`) as native project rules.
- Browse every rule in `.cursor/rules` and open it with a single click.
- Create new MDC rules with the correct header so they appear instantly inside Cursor Settings → Rules.
- Delete rules you no longer need.
- Save project rules as presets that persist across projects on your device (`~/.cursor-agent-rules/presets`).
- Reapply saved presets back into the active project with one button.
- Browse a small built‑in catalog of example rules and copy them into your project or presets.

<p align="center">
  <span style="font-weight: bold; font-size: 1.15em;"><i>It's not magic, it's markdown!</i></span>
  <img src="./media/rulebook-logo-nobg-blue.png" alt="Rulebook logo" width="20%" style="vertical-align: middle; margin-left:8px;" />
</p>

### Status

- Very early development – expect rapid changes.
- Currently implemented as a Cursor extension (installed via VSIX during development).
- VS Code support is planned and will use the same rule/preset format.

### Installation (dev build, Cursor)

```bash
npm install
npm run compile
vsce package
```

Then install the generated `.vsix` in your editor (for now, Cursor):

1. Open Cursor.
2. Go to `Extensions → … → Install from VSIX…`.
3. Select the generated `rulebook-*.vsix` file.

### Usage

- Open your editor with the Rulebook extension installed (currently Cursor).
- Open the sidebar and click the Rulebook icon.
- From the Rulebook view you can:
  - Browse existing rules and open them in an editor.
  - Create new MDC rules with the correct metadata fields.
  - Delete rules that are no longer needed.
  - Save rules as presets and apply presets to the current project.

### Screenshots

Capture a few screenshots of the extension and save them under `./media` using the filenames below so they render automatically:

![Rulebook sidebar with rule list](./media/rulebook-sidebar-rules.png)

![Rule editor with MDC metadata](./media/rulebook-rule-editor.png)

![Preset management view](./media/rulebook-presets.png)

### License

MIT – see `LICENSE`.

