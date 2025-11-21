# Rulebook - Instruction Manager for Agents

#### *It's not magic, it's markdown.*

<p align="center">
  <img src="./media/rulebook-logo-nobg-blue.png" alt="Rulebook logo" style="width:50%;" />
</p>

#### Rulebook is a streamlined way to add, edit, and discover the system instructions and rules that elevate agent-assisted coding. 

## Status

Very early development - Expect rapid changes.
- Supports Cursor IDE currently (Open VSX Registry) 
- VSCode integration is coming very soon!

## What works today

- Browse every rule in `.cursor/rules`, open it with a single click, and delete it if needed.
- Create new MDC rules with the correct `description`, `scope`, `globs`, and `alwaysApply` header so they appear instantly inside Cursor Settings → Rules.
- Save any project rule as a preset (`~/.cursor-agent-rules/presets`) and reapply presets back into the active project with one button.

## Install (dev build)

```
npm install
npm run compile
vsce package
```

Then install the generated `.vsix` inside **Cursor → Extensions → … → Install from VSIX…** (publication to Open VSX is planned once the feature stabilises).

## License

MIT – see `LICENSE`.

 
