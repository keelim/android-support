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
    expect(files).toEqual([
      { name: 'app.apk', isDirectory: expect.any(Function) },
      { name: 'app.aab', isDirectory: expect.any(Function) },
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
});
