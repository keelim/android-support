jest.mock('fs', () => {
  const fsMock = {
    accessSync: jest.fn(),
    constants: { R_OK: 4 },
    lstatSync: jest.fn(),
    realpathSync: jest.fn(),
    readdirSync: jest.fn(),
  };
  return {
    __esModule: true,
    default: fsMock,
    ...fsMock,
  };
});

import fs from 'fs';
import { findReleaseFiles } from '../src/utils/io-utils';

describe('findReleaseFiles', () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    (fs.accessSync as jest.Mock).mockReturnValue(undefined);
    (fs.lstatSync as jest.Mock).mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => filePath);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  test('returns only apk and aab files', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      { name: 'app.apk', isFile: () => true },
      { name: 'app.aab', isFile: () => true },
      { name: 'notes.txt', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ]);
    (fs.lstatSync as jest.Mock).mockImplementation((filePath: string) => ({
      isDirectory: () => filePath === '/tmp/releases',
      isFile: () => filePath !== '/tmp/releases',
      isSymbolicLink: () => false,
    }));

    const files = findReleaseFiles('/tmp/releases');

    expect(fs.readdirSync).toHaveBeenCalledWith('/tmp/releases', { withFileTypes: true });
    expect(files).toEqual([{ name: 'app.apk' }, { name: 'app.aab' }]);
    expect(console.log).toHaveBeenCalledWith('Found 2 release files.');
  });

  test('returns undefined when no release artifacts are found', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      { name: 'notes.txt', isFile: () => true },
      { name: 'folder', isFile: () => false },
    ]);

    expect(findReleaseFiles('/tmp/releases')).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith('Found 0 release files.');
  });

  test('throws contextual error when releaseDirectory cannot be read', () => {
    (fs.readdirSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => findReleaseFiles('/tmp/missing/releases')).toThrow('Unable to read releaseDirectory "releases": ENOENT');
  });

  test('normalizes non-Error releaseDirectory read failures', () => {
    (fs.readdirSync as jest.Mock).mockImplementation(() => {
      throw 'permission denied';
    });

    expect(() => findReleaseFiles('/tmp/blocked/releases')).toThrow('Unable to read releaseDirectory "releases": permission denied');
  });

  test('rejects symlink release artifacts', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([{ name: 'app.apk', isFile: () => true }]);
    (fs.lstatSync as jest.Mock).mockImplementation((filePath: string) => ({
      isDirectory: () => filePath === '/tmp/releases',
      isFile: () => filePath !== '/tmp/releases',
      isSymbolicLink: () => filePath.endsWith('app.apk'),
    }));

    expect(() => findReleaseFiles('/tmp/releases')).toThrow('release artifact must not be a symbolic link: app.apk');
  });
});
