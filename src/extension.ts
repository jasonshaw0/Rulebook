import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type RuleScope = 'project' | 'preset';
type RuleSource = 'project' | 'userPreset' | 'discover';

interface RuleDescriptor {
  id: string; // file path, used as stable identifier
  title: string;
  scope: RuleScope;
  filePath: string;
  source: RuleSource;
  tag?: string; // canonical tag name without leading '#'
}

interface GroupedRules {
  project: Array<Pick<RuleDescriptor, 'id' | 'title' | 'tag'>>;
  presets: Array<Pick<RuleDescriptor, 'id' | 'title' | 'tag'>>;
  discover: Array<Pick<RuleDescriptor, 'id' | 'title' | 'tag'>>;
  allTags: string[];
  projectRulesSupported: boolean;
  projectRulesDirExists: boolean;
  projectRulesPath: string | null;
  workspaceName: string | null;
}

class RulesManager {
  private readonly workspaceRoot?: string;
  private readonly extensionPath: string;

  constructor(context: vscode.ExtensionContext) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.extensionPath = context.extensionPath;
  }

  private parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/);
    if (!match) {
      return { meta: {}, body: text };
    }

    const metaLines = match[1].split(/\r?\n/);
    const meta: Record<string, string> = {};
    for (const line of metaLines) {
      const idx = line.indexOf(':');
      if (idx === -1) {
        continue;
      }
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) {
        meta[key] = value;
      }
    }

    const body = text.slice(match[0].length);
    return { meta, body };
  }

  private buildFrontmatter(meta: Record<string, string>): string {
    const lines = Object.entries(meta).map(([key, value]) =>
      value ? `${key}: ${value}` : `${key}:`
    );
    return `---\n${lines.join('\n')}\n---\n\n`;
  }

  private defaultBody(): string {
    return '# @agent-rule\n\nDescribe the rule here. This content will be included in your rules context.\n';
  }

  private normalizeScope(value: string | undefined, fallback: RuleScope): RuleScope {
    const lower = value?.toLowerCase();
    return lower === 'project' || lower === 'preset' ? (lower as RuleScope) : fallback;
  }

  private getDiscoverDir(): string {
    return path.join(this.extensionPath, 'discover');
  }

  private getPresetDir(): string {
    // Local presets managed by Rulebook; Cursor itself ignores this directory.
    return path.join(os.homedir(), '.cursor-agent-rules', 'presets');
  }

  private getProjectDir(): string | undefined {
    // Real Cursor project rules live in .cursor/rules as MDC files.
    if (!this.workspaceRoot) {
      return undefined;
    }
    return path.join(this.workspaceRoot, '.cursor', 'rules');
  }

  async init(): Promise<void> {
    // Best-effort create; never throw from here so activation always succeeds.
    const dirs = [this.getPresetDir()];
    await Promise.all(
      dirs.map(dir =>
        fs.promises.mkdir(dir, { recursive: true }).catch(err => {
          console.error('Rulebook: failed to create rules directory', dir, err);
        })
      )
    );
  }

  private async loadRulesFromDir(
    dir: string | undefined,
    defaultScope: RuleScope,
    source: RuleSource
  ): Promise<RuleDescriptor[]> {
    if (!dir) {
      return [];
    }

    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return [];
    }

    const rules: RuleDescriptor[] = [];
    for (const name of entries) {
      const fullPath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const parsed = await this.parseRuleFile(fullPath, defaultScope);
      if (parsed) {
        rules.push({ ...parsed, source });
      }
    }

    return rules;
  }

  private async parseRuleFile(
    filePath: string,
    defaultScope: RuleScope
  ): Promise<Omit<RuleDescriptor, 'source'> | undefined> {
    let text: string;
    try {
      text = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }

    const { meta, body } = this.parseFrontmatter(text);

    let scope: RuleScope = this.normalizeScope(meta.scope, defaultScope);
    let title = meta.description?.trim() || path.basename(filePath, path.extname(filePath));

    let tag: string | undefined;
    if (meta.tag) {
      let raw = meta.tag.split(',')[0].trim();
      if (raw.startsWith('#')) {
        raw = raw.slice(1);
      }
      if (raw) {
        tag = raw;
      }
    }

    if (!meta.scope) {
      const scopeMatch = /^#\s*scope\s*:\s*(project|preset)\s*$/im.exec(body);
      if (scopeMatch) {
        scope = this.normalizeScope(scopeMatch[1], scope);
      }
    }

    if (!meta.description) {
      const titleMatch = /^#\s*title\s*:\s*(.+)$/im.exec(body);
      if (titleMatch) {
        const candidate = titleMatch[1].trim();
        if (candidate.length > 0) {
          title = candidate;
        }
      }
    }

    return {
      id: filePath,
      filePath,
      scope,
      title,
      tag
    };
  }

  private async loadAllRules(): Promise<RuleDescriptor[]> {
    const [presetRules, projectRules, discoverRules] = await Promise.all([
      this.loadRulesFromDir(this.getPresetDir(), 'preset', 'userPreset'),
      this.loadRulesFromDir(this.getProjectDir(), 'project', 'project'),
      this.loadRulesFromDir(this.getDiscoverDir(), 'preset', 'discover')
    ]);

    return [...presetRules, ...projectRules, ...discoverRules];
  }

  async getGroupedRules(): Promise<GroupedRules> {
    const all = await this.loadAllRules();
    const projectDir = this.getProjectDir();
    const projectRulesDirExists = projectDir ? fs.existsSync(projectDir) : false;
    const workspaceName = this.workspaceRoot ? path.basename(this.workspaceRoot) : null;

    const project = all
      .filter(r => r.source === 'project')
      .map(r => ({ id: r.id, title: r.title, tag: r.tag }));
    const presets = all
      .filter(r => r.source === 'userPreset')
      .map(r => ({ id: r.id, title: r.title, tag: r.tag }));
    const discover = all
      .filter(r => r.source === 'discover')
      .map(r => ({ id: r.id, title: r.title, tag: r.tag }));

    const tagSet = new Set<string>();
    for (const rule of [...project, ...presets, ...discover]) {
      if (rule.tag) {
        tagSet.add(rule.tag);
      }
    }

    let projectRulesPath: string | null = null;
    if (projectDir && this.workspaceRoot) {
      projectRulesPath = path.relative(this.workspaceRoot, projectDir).replace(/\\/g, '/');
    }

    return {
      project,
      presets,
      discover,
      allTags: Array.from(tagSet),
      projectRulesSupported: Boolean(this.workspaceRoot),
      projectRulesDirExists,
      projectRulesPath,
      workspaceName
    };
  }

  private getDirectoryForScope(scope: RuleScope): string | undefined {
    switch (scope) {
      case 'preset':
        return this.getPresetDir();
      case 'project':
        return this.getProjectDir();
      default:
        return undefined;
    }
  }

  private slugify(title: string): string {
    const base =
      title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'rule';
    return base;
  }

  async createRule(scope: RuleScope, title: string): Promise<RuleDescriptor> {
    const dir = this.getDirectoryForScope(scope);
    if (!dir) {
      throw new Error('Open a workspace folder to create project rules.');
    }

    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {
      // best-effort
    });

    const slug = this.slugify(title || 'rule');
    const ext = scope === 'project' ? '.mdc' : '.md';
    let filePath = path.join(dir, `${slug}${ext}`);
    let counter = 1;
    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `${slug}-${counter}${ext}`);
      counter += 1;
    }

    const metadata: Record<string, string> = {
      description: title,
      scope
    };

    if (scope === 'project') {
      metadata.globs = '';
      metadata.alwaysApply = 'true';
    }

    const content = `${this.buildFrontmatter(metadata)}${this.defaultBody()}`;

    await fs.promises.writeFile(filePath, content, 'utf8');

    const parsed = await this.parseRuleFile(filePath, scope);
    if (!parsed) {
      throw new Error('Failed to create rule file.');
    }

    const descriptor: RuleDescriptor = {
      ...parsed,
      source: scope === 'project' ? 'project' : 'userPreset'
    };

    await this.syncCursorrules();
    return descriptor;
  }

  async deleteRule(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore
    }
    await this.syncCursorrules();
  }

  async openRule(filePath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async findRuleById(id: string): Promise<RuleDescriptor | undefined> {
    const all = await this.loadAllRules();
    return all.find(r => r.id === id);
  }

  async ensureProjectRulesDir(): Promise<void> {
    const dir = this.getProjectDir();
    if (!dir) {
      throw new Error('Open a workspace folder to create project rules.');
    }
    await fs.promises.mkdir(dir, { recursive: true });
  }

  async duplicateRuleToScope(sourceId: string, targetScope: RuleScope): Promise<RuleDescriptor> {
    const source = await this.findRuleById(sourceId);
    if (!source) {
      throw new Error('Rule not found.');
    }

    let content: string;
    try {
      content = await fs.promises.readFile(source.filePath, 'utf8');
    } catch {
      throw new Error('Failed to read rule file.');
    }

    const { meta, body } = this.parseFrontmatter(content);
    const normalizedBody = body.replace(/^\s*/, '');

    const newMeta: Record<string, string> = {
      ...meta,
      description: meta.description || source.title,
      scope: targetScope
    };

    if (targetScope === 'project') {
      newMeta.globs = newMeta.globs ?? '';
      newMeta.alwaysApply = newMeta.alwaysApply ?? 'true';
    } else {
      delete newMeta.globs;
      delete newMeta.alwaysApply;
    }

    const dir = this.getDirectoryForScope(targetScope);
    if (!dir) {
      throw new Error('Open a workspace folder to create project rules.');
    }

    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {
      // best-effort
    });

    const slug = this.slugify(source.title || path.basename(source.filePath));
    const ext = targetScope === 'project' ? '.mdc' : '.md';
    let destPath = path.join(dir, `${slug}${ext}`);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(dir, `${slug}-${counter}${ext}`);
      counter += 1;
    }

    const finalContent = `${this.buildFrontmatter(newMeta)}${normalizedBody.length > 0 ? normalizedBody : this.defaultBody()
      }`;

    await fs.promises.writeFile(destPath, finalContent, 'utf8');

    const parsed = await this.parseRuleFile(destPath, targetScope);
    if (!parsed) {
      throw new Error('Failed to create duplicated rule.');
    }

    const descriptor: RuleDescriptor = {
      ...parsed,
      source: targetScope === 'project' ? 'project' : 'userPreset'
    };

    await this.syncCursorrules();
    return descriptor;
  }

  async syncCursorrules(): Promise<void> {
    // Legacy .cursorrules support is deprecated; no-op for now.
  }
}

/**
 * View provider for the rulebook sidebar.
 * Renders lists of project rules and presets, and lets the user add/edit/delete them.
 */
class AgentRulesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentRulesView';
  private view?: vscode.WebviewView;

  constructor(private readonly rulesManager: RulesManager) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'ready': {
          await this.postState();
          break;
        }
        case 'addRule': {
          await this.handleAddRule(message.scope as RuleScope);
          break;
        }
        case 'editRule': {
          await this.handleEditRule(message.id as string);
          break;
        }
        case 'deleteRule': {
          await this.handleDeleteRule(message.id as string);
          break;
        }
        case 'projectToPreset': {
          try {
            await this.rulesManager.duplicateRuleToScope(message.id as string, 'preset');
            await this.postState();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Failed to save rule as preset.';
            vscode.window.showErrorMessage(message);
            console.error('Rulebook: failed to duplicate rule to preset', err);
          }
          break;
        }
        case 'presetToProject': {
          try {
            await this.rulesManager.duplicateRuleToScope(message.id as string, 'project');
            await this.postState();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Failed to add preset to project.';
            vscode.window.showErrorMessage(message);
            console.error('Rulebook: failed to duplicate preset to project', err);
          }
          break;
        }
        case 'toggleSection': {
          // No-op on extension side; purely client-side in the webview.
          break;
        }
        case 'createProjectRulesDir': {
          try {
            await this.rulesManager.ensureProjectRulesDir();
            await this.postState();
          } catch (err) {
            const message =
              err instanceof Error
                ? err.message
                : 'Failed to create .cursor/rules directory. See console for details.';
            vscode.window.showErrorMessage(message);
            console.error('Rulebook: failed to create project rules directory', err);
          }
          break;
        }
        case 'refreshDiscover': {
          await this.postState();
          break;
        }
        default:
          break;
      }
    });
  }

  private async handleAddRule(scope: RuleScope): Promise<void> {
    const title = await vscode.window.showInputBox({
      title: 'New Agent Rule',
      prompt: 'This title appears in the Agent Rules list.',
      placeHolder: 'e.g. Prefer concise answers, Use Tailwind, etc.',
      ignoreFocusOut: true,
      validateInput: value => (!value.trim() ? 'Title is required.' : undefined)
    });

    if (!title || !title.trim()) {
      return;
    }

    try {
      const rule = await this.rulesManager.createRule(scope, title.trim());
      await this.rulesManager.openRule(rule.filePath);
      await this.postState();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create rule. See console for details.';
      vscode.window.showErrorMessage(message);
      console.error('Rulebook: failed to create rule', err);
    }
  }

  private async handleEditRule(id: string): Promise<void> {
    if (!id) {
      return;
    }
    try {
      await this.rulesManager.openRule(id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to open rule. See console for details.';
      vscode.window.showErrorMessage(message);
      console.error('Rulebook: failed to open rule', err);
    }
  }

  private async handleDeleteRule(id: string): Promise<void> {
    if (!id) {
      return;
    }

    const rule = await this.rulesManager.findRuleById(id);
    const displayName = rule?.title ?? path.basename(id);

    const choice = await vscode.window.showWarningMessage(
      `Delete rule "${displayName}"? This will delete the underlying file.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }

    try {
      await this.rulesManager.deleteRule(id);
      await this.postState();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete rule. See console for details.';
      vscode.window.showErrorMessage(message);
      console.error('Rulebook: failed to delete rule', err);
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const state = await this.rulesManager.getGroupedRules();
    this.view.webview.postMessage({ type: 'rulesState', state });
  }

  private getHtmlForWebview(): string {
    const nonce = getNonce();

    const styles = `
      <style>
        :root {
          color-scheme: light dark;
        }

        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          color: var(--vscode-foreground);
          background-color: var(--vscode-sideBar-background, transparent);
        }

        .rb-header {
          padding: 8px 10px 6px 10px;
          border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255, 255, 255, 0.06));
        }

        .rb-header-main {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 2px;
        }

        .rb-logo {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
        }

        .rb-title-main {
          font-size: 16px;
          font-weight: 600;
        }

        .rb-title-sub {
          font-size: 11px;
          opacity: 0.8;
          margin-top: 1px;
        }

        .rb-caption {
          font-size: 11px;
          opacity: 0.7;
          margin-top: 4px;
        }

        .sections {
          display: flex;
          flex-direction: column;
        }

        .section {
          margin: 0;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: default;
          padding: 0 8px;
          height: 22px;
          line-height: 22px;
          color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
          background-color: var(--vscode-sideBarSectionHeader-background, transparent);
          border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
        }

        .section-header:hover {
          background-color: var(--vscode-list-hoverBackground);
        }

        .section-header-left {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .chevron {
          font-size: 14px;
          width: 14px;
          text-align: center;
          opacity: 0.7;
        }

        .section-title {
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-size: 11px;
          opacity: 0.9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .project-name {
          opacity: 0.85;
          font-weight: 500;
        }

        .section-subtitle {
          font-size: 11px;
          opacity: 0.7;
          margin-bottom: 1px;
        }

        .section[data-scope="discover"] .section-subtitle {
          margin-bottom: 6px;
        }

        .header-icon-button {
          border: none;
          background: transparent;
          padding: 0 2px;
          cursor: pointer;
          color: var(--vscode-icon-foreground, var(--vscode-foreground));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
        }

        .header-icon-button:hover {
          background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
        }

        .header-icon-button .material-icons-outlined {
          font-size: 16px;
          line-height: 1;
        }

        .section-body {
          padding: 4px 8px 4px 26px;
        }

        .section-collapsed .section-body {
          display: none;
        }

        .section-collapsed .chevron {
          transform: rotate(-90deg);
        }

        .rules-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .rule-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 3px 4px;
          border-radius: 3px;
          cursor: default;
        }

        .rule-item:hover {
          background-color: var(--vscode-list-hoverBackground);
        }

        .rule-title {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 12px;
        }

        .rule-actions {
          display: flex;
          align-items: center;
          gap: 4px;
          opacity: 0;
          transition: opacity 120ms ease-out;
        }

        .rule-item:hover .rule-actions {
          opacity: 1;
        }

        .icon-button {
          border: none;
          background: transparent;
          padding: 0;
          cursor: pointer;
          color: var(--vscode-icon-foreground, var(--vscode-foreground));
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .icon-button .material-icons-outlined {
          font-size: 16px;
          line-height: 1;
        }

        .empty-text {
          font-size: 11px;
          opacity: 0.6;
          padding: 2px 0 4px 0;
        }

        .muted {
          opacity: 0.6;
        }

        .hidden {
          display: none !important;
        }

        .section-header-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .primary-button {
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 12px;
          cursor: pointer;
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }

        .primary-button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }

        .rule-left {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 1;
          min-width: 0;
          padding-right: 6px;
        }

        .tag-pill {
          font-size: 11px;
          font-weight: 600;
          margin-left: 4px;
          color: inherit;
        }

        .tag-bar {
          margin-bottom: 4px;
        }

        .tag-tab {
          display: inline-flex;
          align-items: center;
          padding: 3px 8px;
          border-radius: 10px;
          font-size: 11px;
          margin: 0 4px 4px 0;
          cursor: pointer;
        }

        .tag-tab.selected {
          font-weight: 600;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
        }

        .tag-tab-close {
          margin-right: 4px;
          font-size: 11px;
          opacity: 0.9;
          color: rgba(0, 0, 0, 0.8);
        }

        .project-list .rule-item {
          position: relative;
          border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-contrastBorder));
          padding-left: 10px;
        }

        .project-list .rule-item::before {
          content: "";
          position: absolute;
          left: 2px;
          top: 50%;
          width: 6px;
          height: 6px;
          margin-top: -3px;
          border-radius: 50%;
          background-color: var(--vscode-icon-foreground, var(--vscode-foreground));
          opacity: 0.6;
        }

        .presets-list,
        .discover-list {
          border-top: 1px solid rgba(255, 255, 255, 0.14);
          margin-top: 2px;
        }

        .presets-list .rule-item,
        .discover-list .rule-item {
          border-bottom: 1px solid rgba(255, 255, 255, 0.14);
        }

        .presets-list .rule-item:last-child,
        .discover-list .rule-item:last-child {
          border-bottom: none;
        }
      </style>
    `;

    const script = `
      const vscode = acquireVsCodeApi();

      const state = {
        project: [],
        presets: [],
        discover: [],
        allTags: [],
        projectRulesSupported: true,
        projectRulesDirExists: false,
        projectRulesPath: null,
        selectedDiscoverTag: null,
        tagColors: {},
        workspaceName: null
      };

      const tagPalette = [
        '#ea580c',
        '#15803d',
        '#1d4ed8',
        '#a16207',
        '#9d174d',
        '#7c2d12',
        '#0f766e',
        '#b91c1c'
      ];

      function getTagColor(tag) {
        if (!tag) return null;
        if (!state.tagColors[tag]) {
          const keys = Object.keys(state.tagColors);
          const color = tagPalette[keys.length % tagPalette.length];
          state.tagColors[tag] = color;
        }
        return state.tagColors[tag];
      }

      function renderSection(scope, items) {
        const list = document.getElementById(scope + '-rules');
        if (!list) {
          return;
        }
        list.innerHTML = '';
        if (!items || items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-text';
          empty.textContent = 'No rules yet.';
          list.appendChild(empty);
          return;
        }

        for (const rule of items) {
          const li = document.createElement('li');
          li.className = 'rule-item';
          const left = document.createElement('div');
          left.className = 'rule-left';

          const titleSpan = document.createElement('span');
          titleSpan.className = 'rule-title';
          titleSpan.textContent = rule.title || 'Untitled rule';
          left.appendChild(titleSpan);

          if (rule.tag) {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'tag-pill';
            tagSpan.textContent = '#' + rule.tag;
            const color = getTagColor(rule.tag);
            if (color) {
              tagSpan.style.color = color;
            }
            left.appendChild(tagSpan);
          }

          li.appendChild(left);

          const actions = document.createElement('div');
          actions.className = 'rule-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'icon-button';
          editBtn.title = 'Edit rule';
          editBtn.innerHTML = '<span class="material-icons-outlined">edit</span>';
          editBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'editRule', id: rule.id });
          });

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'icon-button';
          deleteBtn.title = 'Delete rule';
          deleteBtn.innerHTML = '<span class="material-icons-outlined">delete</span>';
          deleteBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'deleteRule', id: rule.id });
          });

          actions.appendChild(editBtn);
          actions.appendChild(deleteBtn);

          if (scope === 'project') {
            const toPresetBtn = document.createElement('button');
            toPresetBtn.className = 'icon-button';
            toPresetBtn.title = 'Save as preset';
            toPresetBtn.innerHTML = '<span class="material-icons-outlined">post_add</span>';
            toPresetBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              vscode.postMessage({ command: 'projectToPreset', id: rule.id });
            });
            actions.appendChild(toPresetBtn);
          } else if (scope === 'presets') {
            const toProjectBtn = document.createElement('button');
            toProjectBtn.className = 'icon-button';
            toProjectBtn.title = 'Add to project rules';
            toProjectBtn.innerHTML = '<span class="material-icons-outlined">publish</span>';
            toProjectBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              vscode.postMessage({ command: 'presetToProject', id: rule.id });
            });
            actions.appendChild(toProjectBtn);
          }

          li.appendChild(actions);

          li.addEventListener('click', () => {
            vscode.postMessage({ command: 'editRule', id: rule.id });
          });

          list.appendChild(li);
        }
      }

      function renderDiscover() {
        const list = document.getElementById('discover-rules');
        const tagBar = document.getElementById('discover-tags');
        if (!list || !tagBar) {
          return;
        }

        // Tag tabs
        tagBar.innerHTML = '';
        let tags = Array.from(state.allTags || []);
        if (state.selectedDiscoverTag) {
          tags = tags.sort((a, b) => {
            if (a === state.selectedDiscoverTag) return -1;
            if (b === state.selectedDiscoverTag) return 1;
            return a.localeCompare(b);
          });
        }

        tags.forEach(tag => {
          const pill = document.createElement('span');
          pill.className = 'tag-tab';
          const color = getTagColor(tag);
          if (color) {
            pill.style.backgroundColor = color;
          }

          if (tag === state.selectedDiscoverTag) {
            pill.classList.add('selected');
            const close = document.createElement('span');
            close.className = 'tag-tab-close';
            close.textContent = '×';
            pill.appendChild(close);
          }

          const label = document.createElement('span');
          label.textContent =
            '#' + tag;
          pill.appendChild(label);

          pill.addEventListener('click', (event) => {
            event.stopPropagation();
            if (tag === state.selectedDiscoverTag) {
              state.selectedDiscoverTag = null;
            } else {
              state.selectedDiscoverTag = tag;
            }
            renderDiscover();
          });

          tagBar.appendChild(pill);
        });

        // List of discover rules
        list.innerHTML = '';
        let rules = state.discover || [];
        if (state.selectedDiscoverTag) {
          rules = rules.filter(r => r.tag === state.selectedDiscoverTag);
        }

        if (!rules.length) {
          const empty = document.createElement('div');
          empty.className = 'empty-text';
          empty.textContent = 'No rules yet.';
          list.appendChild(empty);
          return;
        }

        for (const rule of rules) {
          const li = document.createElement('li');
          li.className = 'rule-item';

          const left = document.createElement('div');
          left.className = 'rule-left';

          const titleSpan = document.createElement('span');
          titleSpan.className = 'rule-title';
          titleSpan.textContent = rule.title || 'Untitled rule';
          left.appendChild(titleSpan);

          if (rule.tag) {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'tag-pill';
            tagSpan.textContent = '#' + rule.tag;
            const color = getTagColor(rule.tag);
            if (color) {
              tagSpan.style.color = color;
            }
            left.appendChild(tagSpan);
          }

          li.appendChild(left);

          const actions = document.createElement('div');
          actions.className = 'rule-actions';

          const toPresetBtn = document.createElement('button');
          toPresetBtn.className = 'icon-button';
          toPresetBtn.title = 'Save as user preset';
          toPresetBtn.innerHTML = '<span class="material-icons-outlined">post_add</span>';
          toPresetBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'projectToPreset', id: rule.id });
          });

          const toProjectBtn = document.createElement('button');
          toProjectBtn.className = 'icon-button';
          toProjectBtn.title = 'Add to project rules';
          toProjectBtn.innerHTML = '<span class="material-icons-outlined">publish</span>';
          toProjectBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'presetToProject', id: rule.id });
          });

          actions.appendChild(toPresetBtn);
          actions.appendChild(toProjectBtn);

          li.appendChild(actions);

          list.appendChild(li);
        }
      }

      function renderAll() {
        renderSection('project', state.project);
        renderSection('presets', state.presets);
        renderDiscover();

        const projectSection = document.querySelector('[data-scope="project"]');
        const projectSubtitle = document.getElementById('project-subtitle');
        const projectAddButton = document.getElementById('add-project-rule');
        const projectTitle = document.getElementById('project-title');
        const projectCreateButton = document.getElementById('project-create-dir');

        const workspaceName = state.workspaceName || 'Workspace';

        if (!state.projectRulesSupported) {
          if (projectSection) {
            projectSection.classList.add('muted');
          }
          if (projectSubtitle) {
            projectSubtitle.textContent = 'Open a workspace folder to use project rules.';
          }
          if (projectAddButton) {
            projectAddButton.disabled = true;
          }
          if (projectTitle) {
            projectTitle.innerHTML = '<span class="project-name">' + workspaceName + '</span> Project Rules';
            projectTitle.classList.remove('hidden');
          }
          if (projectCreateButton) {
            projectCreateButton.classList.add('hidden');
          }
          return;
        }

        if (projectSection) {
          projectSection.classList.remove('muted');
        }

        if (state.projectRulesDirExists) {
          if (projectTitle) {
            projectTitle.innerHTML = '<span class="project-name">' + workspaceName + '</span> Project Rules';
            projectTitle.classList.remove('hidden');
          }
          if (projectCreateButton) {
            projectCreateButton.classList.add('hidden');
          }
          if (projectSubtitle) {
            projectSubtitle.textContent = 'Workspace-specific rules stored in .cursor/rules.';
          }
          if (projectAddButton) {
            projectAddButton.disabled = false;
            projectAddButton.classList.remove('hidden');
          }
        } else {
          if (projectTitle) {
            projectTitle.innerHTML = '<span class="project-name">' + workspaceName + '</span> Project Rules';
            projectTitle.classList.remove('hidden');
          }
          if (projectCreateButton) {
            projectCreateButton.classList.remove('hidden');
          }
          if (projectAddButton) {
            projectAddButton.classList.add('hidden');
          }
          if (projectSubtitle) {
            projectSubtitle.textContent = 'Create .cursor/rules to start adding project rules.';
          }
        }
      }

      window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'rulesState') {
          state.project = message.state.project || [];
          state.presets = message.state.presets || [];
          state.discover = message.state.discover || [];
          state.allTags = message.state.allTags || [];
          state.projectRulesSupported = !!message.state.projectRulesSupported;
          state.projectRulesDirExists = !!message.state.projectRulesDirExists;
          state.projectRulesPath = message.state.projectRulesPath || null;
          state.workspaceName = message.state.workspaceName || null;
          renderAll();
        }
      });

      function handleAdd(scope) {
        vscode.postMessage({ command: 'addRule', scope });
      }

      function handleToggleSection(scope) {
        const section = document.querySelector('[data-scope="' + scope + '"]');
        if (!section) {
          return;
        }
        section.classList.toggle('section-collapsed');
      }

      document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('add-project-rule')?.addEventListener('click', (event) => {
          event.stopPropagation();
          handleAdd('project');
        });
        document.getElementById('add-preset-rule')?.addEventListener('click', (event) => {
          event.stopPropagation();
          handleAdd('preset');
        });
        document.getElementById('project-create-dir')?.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'createProjectRulesDir' });
        });
        document.getElementById('refresh-discover')?.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'refreshDiscover' });
        });

        document.querySelectorAll('.section-header').forEach(header => {
          header.addEventListener('click', (event) => {
            const button = header.querySelector('.header-icon-button');
            if (button && button.contains(event.target)) {
              // Click was on the Add button; already handled separately.
              return;
            }
            const scope = header.getAttribute('data-scope');
            if (!scope) {
              return;
            }
            handleToggleSection(scope);
          });
        });

        vscode.postMessage({ command: 'ready' });
      });
    `;

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet" />
        ${styles}
      </head>
      <body>
        <div class="sections">
          <div class="section" data-scope="project">
            <div class="section-header" data-scope="project">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div id="project-title" class="section-title"></div>
              </div>
              <div class="section-header-actions">
                <button id="project-create-dir" class="primary-button hidden">Create .cursor/rules</button>
                <button id="add-project-rule" class="header-icon-button" title="Add project rule">
                  <span class="material-icons-outlined">add</span>
                </button>
              </div>
            </div>
            <div class="section-body">
              <div id="project-subtitle" class="section-subtitle">Workspace-specific rules stored in .cursor/rules.</div>
              <ul id="project-rules" class="rules-list project-list"></ul>
            </div>
          </div>

          <div class="section" data-scope="presets">
            <div class="section-header" data-scope="presets">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div class="section-title">User Presets</div>
              </div>
              <button id="add-preset-rule" class="header-icon-button" title="Add preset rule">
                <span class="material-icons-outlined">add</span>
              </button>
            </div>
            <div class="section-body">
              <div class="section-subtitle">Reusable rules shared across all workspaces on this device.</div>
              <ul id="presets-rules" class="rules-list presets-list"></ul>
            </div>
          </div>

          <div class="section" data-scope="discover">
            <div class="section-header" data-scope="discover">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div class="section-title">Discover Rules</div>
              </div>
              <div class="section-header-actions">
                <button id="refresh-discover" class="header-icon-button" title="Refresh discover rules">
                  <span class="material-icons-outlined">refresh</span>
                </button>
              </div>
            </div>
            <div class="section-body">
              <div class="section-subtitle">Starter rules bundled with Rulebook. Copy them into your project or presets.</div>
              <div id="discover-tags" class="tag-bar"></div>
              <ul id="discover-rules" class="rules-list discover-list"></ul>
            </div>
          </div>
        </div>

        <script nonce="${nonce}">
          ${script}
        </script>
      </body>
      </html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function activate(context: vscode.ExtensionContext): void {
  const rulesManager = new RulesManager(context);
  const provider = new AgentRulesViewProvider(rulesManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentRulesViewProvider.viewType, provider)
  );

  // Initialise rule directories in the background; UI will still appear even if this fails.
  rulesManager.init().catch(err => {
    const message =
      err instanceof Error ? err.message : 'Unknown error during Rulebook initialisation.';
    console.error('Rulebook: init failed', err);
    vscode.window.showErrorMessage(`Rulebook extension initialisation failed: ${message}`);
  });
}

export function deactivate(): void {
  // No-op for now.
}


