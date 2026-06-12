jest.mock('fs', () => ({
  __esModule: true,
  default: {
    readdirSync: jest.fn(),
  },
}));

import fs from 'fs';
import { findReleaseFiles } from '../src/utils/io-utils';

describe('findReleaseFiles', () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  test('returns only apk and aab files', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      { name: 'app.apk', isDirectory: () => false },
      { name: 'app.aab', isDirectory: () => false },
      { name: 'notes.txt', isDirectory: () => false },
      { name: 'nested', isDirectory: () => true },
    ]);

    const files = findReleaseFiles('/tmp/releases');

    expect(fs.readdirSync).toHaveBeenCalledWith('/tmp/releases', { withFileTypes: true });
    expect(files?.map(file => ({ name: file.name, isDirectory: file.isDirectory() }))).toEqual([
      { name: 'app.apk', isDirectory: false },
      { name: 'app.aab', isDirectory: false },
    ]);
    expect(console.log).toHaveBeenCalledWith('Found 2 release files.');
  });

  test('returns undefined when no release artifacts are found', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      { name: 'notes.txt', isDirectory: () => false },
      { name: 'folder', isDirectory: () => true },
    ]);

    expect(findReleaseFiles('/tmp/releases')).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith('Found 0 release files.');
  });

  test('throws contextual error when releaseDirectory cannot be read', () => {
    (fs.readdirSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => findReleaseFiles('/missing/releases')).toThrow('Unable to read releaseDirectory "/missing/releases": ENOENT');
  });

  test('normalizes non-Error releaseDirectory read failures', () => {
    (fs.readdirSync as jest.Mock).mockImplementation(() => {
      throw 'permission denied';
    });

    expect(() => findReleaseFiles('/blocked/releases')).toThrow('Unable to read releaseDirectory "/blocked/releases": permission denied');
  });
});
