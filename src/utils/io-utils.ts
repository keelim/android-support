import fs from 'fs';
import path from 'path';
import { assertPathInsideRoot, resolveSecureDirectory, safeBasenameForLog } from './security-utils';

export interface ReleaseFileEntry {
  name: string;
}

export function findReleaseFiles(releaseDir: string): ReleaseFileEntry[] | undefined {
  let releaseFiles: ReleaseFileEntry[];
  try {
    const releaseRoot = resolveSecureDirectory(releaseDir, 'releaseDirectory');
    releaseFiles = fs
      .readdirSync(releaseRoot, { withFileTypes: true })
      .filter(item => item.isFile() && (item.name.endsWith('.apk') || item.name.endsWith('.aab')))
      .map(item => {
        const releaseFilePath = path.join(releaseRoot, item.name);
        const stats = fs.lstatSync(releaseFilePath);
        if (stats.isSymbolicLink()) {
          throw new Error(`release artifact must not be a symbolic link: ${safeBasenameForLog(releaseFilePath)}`);
        }
        assertPathInsideRoot(fs.realpathSync(releaseFilePath), releaseRoot, 'release artifact');
        return { name: item.name };
      });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read releaseDirectory "${safeBasenameForLog(releaseDir)}": ${message}`);
  }

  console.log('Found ' + releaseFiles.length + ' release files.');

  if (releaseFiles.length > 0) {
    return releaseFiles;
  }
}
