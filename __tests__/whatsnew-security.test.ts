const mockFs = {
  accessSync: jest.fn(),
  constants: { R_OK: 4 },
  lstatSync: jest.fn(),
  realpathSync: jest.fn(),
  readdirSync: jest.fn(),
};

jest.mock('fs', () => ({
  __esModule: true,
  ...mockFs,
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  d: jest.fn(),
}));

import { readFile } from 'fs/promises';
import { readLocalizedReleaseNotes } from '../src/whatsnew';

function statFor(filePath: string, mode: 'directory' | 'file' | 'non-file' | 'symlink' | 'large') {
  const isDirectoryPath = filePath.endsWith('/whatsnew');
  return {
    isDirectory: () => isDirectoryPath || mode === 'directory',
    isFile: () => !isDirectoryPath && (mode === 'file' || mode === 'large'),
    isSymbolicLink: () => !isDirectoryPath && mode === 'symlink',
    size: mode === 'large' ? 128 * 1024 + 1 : 8,
  };
}

describe('readLocalizedReleaseNotes security checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.accessSync.mockReturnValue(undefined);
    mockFs.realpathSync.mockImplementation((filePath: string) => filePath);
    mockFs.readdirSync.mockReturnValue(['whatsnew-en-US']);
    (readFile as jest.Mock).mockResolvedValue('notes');
  });

  test('rejects symlink whatsnew files', async () => {
    mockFs.lstatSync.mockImplementation((filePath: string) => statFor(filePath, 'symlink'));

    await expect(readLocalizedReleaseNotes('/tmp/whatsnew')).rejects.toThrow(
      'whatsNewDirectory must not contain symbolic links: whatsnew-en-US'
    );
  });

  test('skips matching entries that are not regular files', async () => {
    mockFs.lstatSync.mockImplementation((filePath: string) => statFor(filePath, 'non-file'));

    await expect(readLocalizedReleaseNotes('/tmp/whatsnew')).resolves.toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('rejects oversized whatsnew files', async () => {
    mockFs.lstatSync.mockImplementation((filePath: string) => statFor(filePath, 'large'));

    await expect(readLocalizedReleaseNotes('/tmp/whatsnew')).rejects.toThrow('whatsnew file is too large: whatsnew-en-US');
  });
});
