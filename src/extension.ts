import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type RuleScope = 'user' | 'project' | 'preset';

interface RuleDescriptor {
  id: string; // file path, used as stable identifier
  title: string;
  scope: RuleScope;
  filePath: string;
}

interface GroupedRules {
  user: Array<Pick<RuleDescriptor, 'id' | 'title'>>;
  project: Array<Pick<RuleDescriptor, 'id' | 'title'>>;
  presets: Array<Pick<RuleDescriptor, 'id' | 'title'>>;
  projectRulesSupported: boolean;
}

class RulesManager {
  private readonly workspaceRoot?: string;

  constructor(_context: vscode.ExtensionContext) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getUserDir(): string {
    return path.join(os.homedir(), '.cursor-agent-rules', 'user');
  }

  private getPresetDir(): string {
    return path.join(os.homedir(), '.cursor-agent-rules', 'presets');
  }

  private getProjectDir(): string | undefined {
    if (!this.workspaceRoot) {
      return undefined;
    }
    return path.join(this.workspaceRoot, '.cursor-agent-rules', 'project');
  }

  async init(): Promise<void> {
    // Best-effort create; never throw from here so activation always succeeds.
    const dirs = [this.getUserDir(), this.getPresetDir()];
    const projectDir = this.getProjectDir();
    if (projectDir) {
      dirs.push(projectDir);
    }

    await Promise.all(
      dirs.map(dir =>
        fs.promises.mkdir(dir, { recursive: true }).catch(err => {
          console.error('Agent Rules: failed to create rules directory', dir, err);
        })
      )
    );
  }

  private async loadRulesFromDir(
    dir: string | undefined,
    defaultScope: RuleScope
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
        rules.push(parsed);
      }
    }

    return rules;
  }

  private async parseRuleFile(
    filePath: string,
    defaultScope: RuleScope
  ): Promise<RuleDescriptor | undefined> {
    let text: string;
    try {
      text = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }

    const lines = text.split(/\r?\n/).slice(0, 32);
    let scope: RuleScope = defaultScope;
    let title = path.basename(filePath, path.extname(filePath));

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const scopeMatch = /^#\s*scope\s*:\s*(user|project|preset)\s*$/i.exec(line);
      if (scopeMatch) {
        scope = scopeMatch[1].toLowerCase() as RuleScope;
        continue;
      }

      const titleMatch = /^#\s*title\s*:\s*(.+)$/i.exec(line);
      if (titleMatch) {
        const candidate = titleMatch[1].trim();
        if (candidate.length > 0) {
          title = candidate;
        }
        continue;
      }
    }

    return {
      id: filePath,
      filePath,
      scope,
      title
    };
  }

  private async loadAllRules(): Promise<RuleDescriptor[]> {
    const [userRules, presetRules, projectRules] = await Promise.all([
      this.loadRulesFromDir(this.getUserDir(), 'user'),
      this.loadRulesFromDir(this.getPresetDir(), 'preset'),
      this.loadRulesFromDir(this.getProjectDir(), 'project')
    ]);

    return [...userRules, ...presetRules, ...projectRules];
  }

  async getGroupedRules(): Promise<GroupedRules> {
    const all = await this.loadAllRules();

    const user = all
      .filter(r => r.scope === 'user')
      .map(r => ({ id: r.id, title: r.title }));
    const project = all
      .filter(r => r.scope === 'project')
      .map(r => ({ id: r.id, title: r.title }));
    const presets = all
      .filter(r => r.scope === 'preset')
      .map(r => ({ id: r.id, title: r.title }));

    return {
      user,
      project,
      presets,
      projectRulesSupported: Boolean(this.workspaceRoot)
    };
  }

  private getDirectoryForScope(scope: RuleScope): string | undefined {
    switch (scope) {
      case 'user':
        return this.getUserDir();
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
    let filePath = path.join(dir, `${slug}.md`);
    let counter = 1;
    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `${slug}-${counter}.md`);
      counter += 1;
    }

    const headerLines = [
      '# @agent-rule',
      `# title: ${title}`,
      `# scope: ${scope}`,
      '',
      'Describe the rule here. This content will be included in your .cursorrules files.',
      ''
    ];

    await fs.promises.writeFile(filePath, headerLines.join('\n'), 'utf8');

    const descriptor = await this.parseRuleFile(filePath, scope);
    if (!descriptor) {
      throw new Error('Failed to create rule file.');
    }

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

  async syncCursorrules(): Promise<void> {
    const all = await this.loadAllRules();

    const userRules = all.filter(r => r.scope === 'user');
    const projectRules = all.filter(r => r.scope === 'project');

    // User-level .cursorrules
    if (userRules.length > 0) {
      const userBlocks = await Promise.all(
        userRules.map(async r => {
          try {
            const text = await fs.promises.readFile(r.filePath, 'utf8');
            return text.trim();
          } catch {
            return '';
          }
        })
      );
      const userPath = path.join(os.homedir(), '.cursorrules');
      await fs.promises.writeFile(userPath, userBlocks.filter(Boolean).join('\n\n'), 'utf8');
    }

    // Project-level .cursorrules
    if (this.workspaceRoot && projectRules.length > 0) {
      const projectBlocks = await Promise.all(
        projectRules.map(async r => {
          try {
            const text = await fs.promises.readFile(r.filePath, 'utf8');
            return text.trim();
          } catch {
            return '';
          }
        })
      );
      const projectPath = path.join(this.workspaceRoot, '.cursorrules');
      await fs.promises.writeFile(
        projectPath,
        projectBlocks.filter(Boolean).join('\n\n'),
        'utf8'
      );
    }
  }
}

/**
 * View provider for the Agent Rules sidebar.
 * Renders lists of user, project, and preset rules, and lets the user add/edit/delete them.
 */
class AgentRulesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentRulesView';
  private view?: vscode.WebviewView;

  constructor(private readonly rulesManager: RulesManager) {}

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
        case 'toggleSection': {
          // No-op on extension side; purely client-side in the webview.
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
      console.error('Agent Rules: failed to create rule', err);
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
      console.error('Agent Rules: failed to open rule', err);
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
      console.error('Agent Rules: failed to delete rule', err);
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
          padding: 4px 0 8px 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          color: var(--vscode-foreground);
          background-color: transparent;
        }

        .sections {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .section {
          padding: 2px 8px 4px 8px;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: default;
          padding: 2px 0;
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
        }

        .section-subtitle {
          font-size: 11px;
          opacity: 0.65;
        }

        .section-header-text {
          display: flex;
          flex-direction: column;
        }

        .header-icon-button {
          border: none;
          background: transparent;
          padding: 2px 4px;
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
          margin-left: 18px;
          padding: 2px 0 4px 0;
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
      </style>
    `;

    const script = `
      const vscode = acquireVsCodeApi();

      const state = {
        user: [],
        project: [],
        presets: [],
        projectRulesSupported: true
      };

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

          const titleSpan = document.createElement('span');
          titleSpan.className = 'rule-title';
          titleSpan.textContent = rule.title;
          li.appendChild(titleSpan);

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
          li.appendChild(actions);

          li.addEventListener('dblclick', () => {
            vscode.postMessage({ command: 'editRule', id: rule.id });
          });

          list.appendChild(li);
        }
      }

      function renderAll() {
        renderSection('user', state.user);
        renderSection('project', state.project);
        renderSection('presets', state.presets);

        const projectSection = document.querySelector('[data-scope="project"]');
        const projectSubtitle = document.getElementById('project-subtitle');
        const projectAddButton = document.getElementById('add-project-rule');

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
        } else {
          if (projectSection) {
            projectSection.classList.remove('muted');
          }
          if (projectSubtitle) {
            projectSubtitle.textContent = 'Applied only to this workspace.';
          }
          if (projectAddButton) {
            projectAddButton.disabled = false;
          }
        }
      }

      window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'rulesState') {
          state.user = message.state.user || [];
          state.project = message.state.project || [];
          state.presets = message.state.presets || [];
          state.projectRulesSupported = !!message.state.projectRulesSupported;
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
        document.getElementById('add-user-rule')?.addEventListener('click', (event) => {
          event.stopPropagation();
          handleAdd('user');
        });
        document.getElementById('add-project-rule')?.addEventListener('click', (event) => {
          event.stopPropagation();
          handleAdd('project');
        });
        document.getElementById('add-preset-rule')?.addEventListener('click', (event) => {
          event.stopPropagation();
          handleAdd('preset');
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
          <div class="section" data-scope="user">
            <div class="section-header" data-scope="user">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div class="section-header-text">
                  <div class="section-title">User Rules</div>
                  <div class="section-subtitle">Applied across all workspaces.</div>
                </div>
              </div>
              <button id="add-user-rule" class="header-icon-button" title="Add user rule">
                <span class="material-icons-outlined">add</span>
              </button>
            </div>
            <div class="section-body">
              <ul id="user-rules" class="rules-list"></ul>
            </div>
          </div>

          <div class="section" data-scope="project">
            <div class="section-header" data-scope="project">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div class="section-header-text">
                  <div class="section-title">Project Rules</div>
                  <div id="project-subtitle" class="section-subtitle">Applied only to this workspace.</div>
                </div>
              </div>
              <button id="add-project-rule" class="header-icon-button" title="Add project rule">
                <span class="material-icons-outlined">add</span>
              </button>
            </div>
            <div class="section-body">
              <ul id="project-rules" class="rules-list"></ul>
            </div>
          </div>

          <div class="section" data-scope="presets">
            <div class="section-header" data-scope="presets">
              <div class="section-header-left">
                <span class="chevron">▾</span>
                <div class="section-header-text">
                  <div class="section-title">Presets</div>
                  <div class="section-subtitle">Saved rules that are not currently applied.</div>
                </div>
              </div>
              <button id="add-preset-rule" class="header-icon-button" title="Add preset rule">
                <span class="material-icons-outlined">add</span>
              </button>
            </div>
            <div class="section-body">
              <ul id="presets-rules" class="rules-list"></ul>
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
      err instanceof Error ? err.message : 'Unknown error during Agent Rules initialisation.';
    console.error('Agent Rules: init failed', err);
    vscode.window.showErrorMessage(`Agent Rules extension initialisation failed: ${message}`);
  });
}

export function deactivate(): void {
  // No-op for now.
}


