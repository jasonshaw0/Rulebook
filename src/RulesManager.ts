import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RuleScope, RuleSource, GroupedRules } from './extension';

export class RulesManager {
  private readonly workspaceRoot?: string;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private parseFrontmatter(text: string): { meta: Record<string, string>; body: string; } {
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
    const lines = Object.entries(meta).map(([key, value]) => value ? `${key}: ${value}` : `${key}:`
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


  private getProjectDir(): string | undefined {
    // Real Cursor project rules live in .cursor/rules as MDC files.
    if (!this.workspaceRoot) {
      return undefined;
    }
    return path.join(this.workspaceRoot, '.vscode');
  }

  private getPresetDir(): string | undefined {
    const userDir = path.join(os.homedir(), '.vscode', 'presets');
    return userDir;
  }

  async init(): Promise<void> {
    // Best-effort create; never throw from here so activation always succeeds.
    if (!this.workspaceRoot) {
      return;
    }
    const projectDir = path.join(this.workspaceRoot, '.vscode');
    await fs.promises.mkdir(projectDir, { recursive: true }).catch(err => {
      console.error('Rulebook: failed to create rules directory', projectDir, err);
    });
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
      const parsed = await this.parseRuleFile({ filePath: fullPath, defaultScope });
      if (parsed) {
        rules.push({ ...parsed, source });
      }
    }

    return rules;
  }

  private async parseRuleFile(
    { filePath, defaultScope }: { filePath: string; defaultScope: RuleScope; }): Promise<Omit<RuleDescriptor, 'source'> | undefined> {
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
    const [presetRules, projectRules] = await Promise.all([
      this.loadRulesFromDir(this.getPresetDir(), 'preset', 'userPreset'),
      this.loadRulesFromDir(this.getProjectDir(), 'project', 'project')
    ]);

    return [...presetRules, ...projectRules];
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

    const tagSet = new Set<string>();
    for (const rule of [...project, ...presets]) {
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
    const base = title
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

    const parsed = await this.parseRuleFile({ filePath, defaultScope: scope });
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

    const finalContent = `${this.buildFrontmatter(newMeta)}${normalizedBody.length > 0 ? normalizedBody : this.defaultBody()}`;

    await fs.promises.writeFile(destPath, finalContent, 'utf8');

    const parsed = await this.parseRuleFile({ filePath: destPath, defaultScope: targetScope });
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
    if (!this.workspaceRoot) {
      return;
    }

    const all = await this.loadAllRules();
    const sections: string[] = [];

    // Add project rules
    const projectRules = all.filter(r => r.source === 'project');
    if (projectRules.length > 0) {
      sections.push('# Project Rules\n');
      for (const rule of projectRules) {
        try {
          const content = await fs.promises.readFile(rule.filePath, 'utf8');
          const { body } = this.parseFrontmatter(content);
          sections.push(`## ${rule.title}\n\n${body.trim()}\n`);
        } catch {
          // Skip rules that can't be read
        }
      }
    }

    // Add preset rules
    const presetRules = all.filter(r => r.source === 'userPreset');
    if (presetRules.length > 0) {
      sections.push('\n# User Presets\n');
      for (const rule of presetRules) {
        try {
          const content = await fs.promises.readFile(rule.filePath, 'utf8');
          const { body } = this.parseFrontmatter(content);
          sections.push(`## ${rule.title}\n\n${body.trim()}\n`);
        } catch {
          // Skip rules that can't be read
        }
      }
    }

    const cursorrulesPath = path.join(this.workspaceRoot, '.cursorrules');
    const finalContent = sections.join('\n').trim() + '\n';

    try {
      await fs.promises.writeFile(cursorrulesPath, finalContent, 'utf8');
    } catch (err) {
      console.error('Rulebook: failed to sync .cursorrules', err);
    }
  }
}
export interface RuleDescriptor {
  id: string; // file path, used as stable identifier
  title: string;
  scope: RuleScope;
  filePath: string;
  source: RuleSource;
  tag?: string; // canonical tag name without leading '#'
}

