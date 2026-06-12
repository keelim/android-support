import fs, { Dirent } from 'fs';

export function findReleaseFiles(releaseDir: string): Dirent[] | undefined {
  let releaseFiles: Dirent[];
  try {
    releaseFiles = fs
      .readdirSync(releaseDir, { withFileTypes: true })
      .filter(item => !item.isDirectory())
      .filter(item => item.name.endsWith('.apk') || item.name.endsWith('.aab'));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read releaseDirectory "${releaseDir}": ${message}`);
  }

  console.log('Found ' + releaseFiles.length + ' release files.');

  if (releaseFiles.length > 0) {
    return releaseFiles;
  }
}
