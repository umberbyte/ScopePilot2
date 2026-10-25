import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_REPORT_PROFILE } from '../../src/main/assurance-report.ts';
import { presentActivatedWorkspace } from '../../src/main/workspace-presentation.ts';

describe('workspace presentation for renderer', () => {
  test('S07 に必要な reportProfile を IPC 応答から落とさない', () => {
    const profile = { ...DEFAULT_REPORT_PROFILE, systemName: '診断対象システム' };
    const presented = presentActivatedWorkspace({
      directory: 'C:\\cases\\case-a',
      dbPath: 'C:\\cases\\case-a\\scopepilot.db',
      existingCase: null,
      existingAuthorization: null,
      settings: {
        startUrl: 'https://example.test/', supportingOrigins: [], targetRoles: ['unauthenticated'], forbiddenActions: [],
        aiProvider: 'codex', aiModel: '', updatedAt: '2026-10-23T00:00:00.000Z',
      },
      inputs: [{
        inputId: 'input-1', relativePath: 'inputs/notes.txt', originalName: 'notes.txt', sha256: 'a'.repeat(64),
        sizeBytes: 5, importedAt: '2026-10-23T00:00:00.000Z',
      }],
      reportProfile: profile,
    });

    assert.deepEqual(presented.reportProfile, profile);
    assert.equal(presented.inputs[0]?.path, join('C:\\cases\\case-a', 'inputs/notes.txt'));
    assert.equal(presented.inputs[0]?.name, 'notes.txt');
  });
});
