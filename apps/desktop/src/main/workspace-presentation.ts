import { join } from 'node:path';
import type { ActivatedWorkspace } from './workspace.ts';

/** Main 内部の workspace を、preload 経由で renderer へ渡す形に投影する。 */
export function presentActivatedWorkspace(activated: ActivatedWorkspace) {
  return {
    directory: activated.directory,
    dbPath: activated.dbPath,
    existingCase: activated.existingCase,
    settings: activated.settings,
    inputs: activated.inputs.map((input) => ({
      ...input,
      path: join(activated.directory, input.relativePath),
      name: input.originalName,
    })),
    reportProfile: activated.reportProfile,
  };
}
