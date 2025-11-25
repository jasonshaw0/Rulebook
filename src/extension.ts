import * as vscode from 'vscode';
import * as path from 'path';
import { RuleDescriptor, RulesManager } from './RulesManager';

export type RuleScope = 'project' | 'preset';
export type RuleSource = 'project' | 'userPreset';

export interface GroupedRules {
  project: Array<Pick<RuleDescriptor, 'id' | 'title' | 'tag'>>;
  presets: Array<Pick<RuleDescriptor, 'id' | 'title' | 'tag'>>;
  allTags: string[];
  projectRulesSupported: boolean;
  projectRulesDirExists: boolean;
  projectRulesPath: string | null;
  workspaceName: string | null;
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

        .presets-list {
          border-top: 1px solid rgba(255, 255, 255, 0.14);
          margin-top: 2px;
        }

        .presets-list .rule-item {
          border-bottom: 1px solid rgba(255, 255, 255, 0.14);
        }

        .presets-list .rule-item:last-child {
          border-bottom: none;
        }
      </style>
    `;

    const script = `
      const vscode = acquireVsCodeApi();

      const state = {
        project: [],
        presets: [],
        allTags: [],
        projectRulesSupported: true,
        projectRulesDirExists: false,
        projectRulesPath: null,
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

      function renderAll() {
        renderSection('project', state.project);
        renderSection('presets', state.presets);

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
              <div id="project-subtitle" class="section-subtitle">Workspace-specific rules. Allows metadata like <code>alwaysApply:</code>, <code>description:</code>, and <code>glob:</code>.</div>
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
  const rulesManager = new RulesManager();
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


