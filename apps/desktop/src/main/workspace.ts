import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { AuthorizationRecord, CaseRecord } from '@scopepilot2/contracts';
import {
  AuthorizationRepository,
  AiInvocationRepository,
  CaseRepository,
  migrate,
  openDatabase,
  RunRepository,
  SqliteEvidenceStore,
  WorkspaceRepository,
  type WorkspaceAiProvider,
  type WorkspaceInputSource,
  type WorkspaceSettings,
} from '@scopepilot2/storage';

export interface WorkspaceSettingsInput {
  readonly startUrl: string;
  readonly supportingOrigins: readonly string[];
  readonly targetRoles: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly aiProvider: WorkspaceAiProvider;
  readonly aiModel: string;
}

export type WorkspaceOpenMode = 'create' | 'open';

export interface ActivatedWorkspace {
  readonly directory: string;
  readonly dbPath: string;
  readonly existingCase: CaseRecord | null;
  readonly existingAuthorization: AuthorizationRecord | null;
  readonly settings: WorkspaceSettings;
  readonly inputs: readonly WorkspaceInputSource[];
}

export interface ActiveWorkspaceRepositories {
  readonly db: DatabaseSync;
  readonly cases: CaseRepository;
  readonly authorizations: AuthorizationRepository;
  readonly runs: RunRepository;
  readonly evidence: SqliteEvidenceStore;
  readonly workspace: WorkspaceRepository;
  readonly aiInvocations: AiInvocationRepository;
}

export interface SavedReportFiles {
  readonly markdownPath: string;
  readonly wordPath: string;
}

const REQUIRED_DIRECTORIES = ['inputs', 'evidence/blobs', 'runs', 'exports', 'reports', 'backups', 'locks'] as const;

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function safeFileName(name: string): string {
  const normalized = name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  return (normalized === '' ? 'input.bin' : normalized).slice(0, 160);
}

function ensureChild(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== resolve(candidate)) {
    throw new Error(`案件フォルダ外のパスは使用できません: ${candidate}`);
  }
}

async function rejectReparsePoint(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`シンボリックリンクまたはジャンクションは案件フォルダに使用できません: ${path}`);
  }
}

async function importOne(root: string, repository: WorkspaceRepository, sourcePath: string): Promise<void> {
  const source = resolve(sourcePath);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error(`資料はファイルを選択してください: ${source}`);
  const sha256 = await sha256File(source);
  const originalName = basename(source);
  const fileName = `${sha256.slice(0, 12)}-${safeFileName(originalName)}`;
  const destination = resolve(root, 'inputs', fileName);
  ensureChild(root, destination);

  let destinationExists = false;
  try {
    destinationExists = (await stat(destination)).isFile();
  } catch {
    destinationExists = false;
  }
  if (destinationExists) {
    if (await sha256File(destination) !== sha256) throw new Error(`取込先の同名ファイルのSHA-256が一致しません: ${destination}`);
  } else {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    ensureChild(root, temporary);
    try {
      await copyFile(source, temporary);
      if (await sha256File(temporary) !== sha256) throw new Error(`資料のコピー検証に失敗しました: ${originalName}`);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  repository.saveInput({
    inputId: `input-${sha256.slice(0, 20)}`,
    relativePath: `inputs/${fileName}`,
    originalName,
    sha256,
    sizeBytes: sourceInfo.size,
    importedAt: new Date().toISOString(),
  });
}

export class DesktopWorkspaceManager {
  private active: ActiveWorkspaceRepositories | null = null;
  private activeDirectory: string | null = null;

  repositories(): ActiveWorkspaceRepositories | null {
    return this.active;
  }

  directory(): string | null {
    return this.activeDirectory;
  }

  async activate(directory: string, materialPaths: readonly string[], input: WorkspaceSettingsInput, mode: WorkspaceOpenMode): Promise<ActivatedWorkspace> {
    const requestedRoot = resolve(directory);
    let existed = true;
    let resumesIncompleteCreation = false;
    try { await stat(requestedRoot); } catch { existed = false; }
    if (mode === 'open') {
      if (!existed) throw new Error('指定した案件フォルダが存在しません');
      try {
        if (!(await stat(join(requestedRoot, 'scopepilot.db'))).isFile()) throw new Error('案件DBではありません');
      } catch {
        throw new Error('既存案件にはscopepilot.dbが必要です');
      }
    } else if (existed) {
      const entries = await readdir(requestedRoot);
      if (entries.length > 0) {
        const knownWorkspaceEntries = new Set([
          'scopepilot.db', 'scopepilot.db-shm', 'scopepilot.db-wal',
          ...REQUIRED_DIRECTORIES.map((entry) => entry.split('/')[0] ?? entry),
        ]);
        const hasDatabase = entries.includes('scopepilot.db');
        if (!hasDatabase || entries.some((entry) => !knownWorkspaceEntries.has(entry))) {
          throw new Error('新規案件には空のフォルダを選択してください');
        }
        resumesIncompleteCreation = true;
      }
    }
    await mkdir(requestedRoot, { recursive: true });
    await rejectReparsePoint(requestedRoot);
    const root = await realpath(requestedRoot);
    for (const child of REQUIRED_DIRECTORIES) {
      const childPath = resolve(root, child);
      ensureChild(root, childPath);
      await mkdir(childPath, { recursive: true });
      await rejectReparsePoint(childPath);
    }

    const dbPath = join(root, 'scopepilot.db');
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      const repositories: ActiveWorkspaceRepositories = {
        db,
        cases: new CaseRepository(db),
        authorizations: new AuthorizationRepository(db),
        runs: new RunRepository(db),
        evidence: new SqliteEvidenceStore(db),
        workspace: new WorkspaceRepository(db),
        aiInvocations: new AiInvocationRepository(db),
      };
      const cases = repositories.cases.list();
      if (cases.length > 1) throw new Error('案件フォルダ内のDBに複数案件が存在します。自動選択できません。');
      if (mode === 'create' && resumesIncompleteCreation && cases.length > 0) {
        throw new Error('作成済み案件です。「既存案件を開く」から選択してください');
      }

      const requestedSettings: WorkspaceSettings = {
        startUrl: input.startUrl.trim(),
        supportingOrigins: [...new Set(input.supportingOrigins.map((value) => value.trim()).filter(Boolean))],
        targetRoles: [...new Set(input.targetRoles.map((value) => value.trim()).filter(Boolean))],
        forbiddenActions: [...new Set(input.forbiddenActions.map((value) => value.trim()).filter(Boolean))],
        aiProvider: input.aiProvider,
        aiModel: input.aiModel.trim(),
        updatedAt: new Date().toISOString(),
      };
      const settings = cases.length === 1 ? repositories.workspace.getSettings() ?? requestedSettings : requestedSettings;
      repositories.workspace.saveSettings(settings);
      for (const source of materialPaths) await importOne(root, repositories.workspace, source);

      const previous = this.active;
      this.active = repositories;
      this.activeDirectory = root;
      previous?.db.close();
      const existingCase = cases[0] ?? null;
      return {
        directory: root,
        dbPath,
        existingCase,
        existingAuthorization: existingCase === null ? null : repositories.authorizations.latest(existingCase.caseId),
        settings,
        inputs: repositories.workspace.listInputs(),
      };
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  async saveReport(content: string, modelHash: string): Promise<SavedReportFiles> {
    if (this.activeDirectory === null || this.active === null) throw new Error('案件フォルダを先に開いてください');
    if (content.trim() === '') throw new Error('空の報告書は保存できません');
    const reportDirectory = resolve(this.activeDirectory, 'reports');
    ensureChild(this.activeDirectory, reportDirectory);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const markdownPath = resolve(reportDirectory, `diagnostic-report-${stamp}.md`);
    const wordPath = resolve(reportDirectory, `diagnostic-report-${stamp}.docx`);
    ensureChild(this.activeDirectory, markdownPath);
    ensureChild(this.activeDirectory, wordPath);
    await writeFile(markdownPath, content, 'utf8');

    const children: Paragraph[] = [];
    for (const line of content.replaceAll('\r\n', '\n').split('\n')) {
      if (line.startsWith('### ')) {
        children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
      } else if (line.startsWith('## ')) {
        children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      } else if (line.startsWith('# ')) {
        children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      } else if (line.startsWith('- ')) {
        children.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
      } else {
        children.push(new Paragraph({ children: [new TextRun(line)] }));
      }
    }
    children.push(new Paragraph({
      children: [new TextRun({ text: `ScopePilot report model hash: ${modelHash}`, color: '666666', size: 18 })],
      spacing: { before: 240 },
    }));
    const document = new Document({
      creator: 'ScopePilot2',
      title: '脆弱性診断報告書',
      description: 'ScopePilot2の検証済み報告モデルから生成した日本語Word報告書',
      styles: {
        default: { document: { run: { font: 'Yu Gothic', size: 22 } } },
      },
      sections: [{ properties: {}, children }],
    });
    await writeFile(wordPath, await Packer.toBuffer(document));
    return { markdownPath, wordPath };
  }

  close(): void {
    this.active?.db.close();
    this.active = null;
    this.activeDirectory = null;
  }
}

