const mockFs = {
  accessSync: jest.fn(),
  constants: { R_OK: 4 },
  lstatSync: jest.fn(),
  mkdtempSync: jest.fn(),
  realpathSync: jest.fn(),
};

jest.mock('fs', () => ({
  __esModule: true,
  ...mockFs,
}));

import path from 'path';
import {
  assertPathInsideAllowedRoots,
  assertPathInsideRoot,
  createSecureTempDir,
  isPathInside,
  maskIdentifier,
  normalizeUnknownError,
  resolveExistingRoot,
  resolveSecureDirectory,
  resolveSecureFile,
  safeBasenameForLog,
  secureTempRoot,
  validateServiceAccountJsonPayload,
} from '../src/utils/security-utils';

function stat(overrides: Partial<{ isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean; size: number }> = {}) {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 10,
    ...overrides,
  };
}

describe('security utils', () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RUNNER_TEMP = '/runner-temp';
    mockFs.accessSync.mockReturnValue(undefined);
    mockFs.lstatSync.mockReturnValue(stat());
    mockFs.mkdtempSync.mockImplementation((prefix: string) => `${prefix}abc`);
    mockFs.realpathSync.mockImplementation((filePath: string) => filePath);
  });

  afterAll(() => {
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
  });

  test('normalizes errors and formats safe log values', () => {
    const error = new Error('native');
    expect(normalizeUnknownError(error)).toBe(error);
    expect(normalizeUnknownError('plain').message).toBe('plain');
    expect(safeBasenameForLog(undefined)).toBe('<empty>');
    expect(safeBasenameForLog('/tmp/secret.json')).toBe('secret.json');
    expect(maskIdentifier(undefined)).toBeUndefined();
    expect(maskIdentifier('short')).toBe('****');
    expect(maskIdentifier('abcdefghijkl')).toBe('abcd...ijkl');
  });

  test('creates temp directories under runner temp and falls back when realpath fails', () => {
    expect(createSecureTempDir('prefix-')).toBe('/runner-temp/prefix-abc');
    expect(mockFs.mkdtempSync).toHaveBeenCalledWith('/runner-temp/prefix-');

    delete process.env.RUNNER_TEMP;
    expect(secureTempRoot()).toBeTruthy();

    mockFs.realpathSync.mockImplementationOnce(() => {
      throw new Error('missing root');
    });
    expect(resolveExistingRoot('/missing-root')).toBe(path.resolve('/missing-root'));
  });

  test('checks path containment', () => {
    expect(isPathInside('/root/a', '/root')).toBe(true);
    expect(isPathInside('/outside/a', '/root')).toBe(false);
    expect(() => assertPathInsideAllowedRoots('/outside/file.txt', 'artifact', ['/allowed'])).toThrow(
      'artifact must be inside the workspace or runner temp directory'
    );
    expect(() => assertPathInsideRoot('/outside/file.txt', '/root', 'artifact')).toThrow('artifact must stay inside root');
  });

  test('resolves secure files and rejects unsafe variants', () => {
    const defaultFile = path.join(process.cwd(), 'default.txt');
    expect(resolveSecureFile(defaultFile, 'artifact')).toBe(defaultFile);
    expect(resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'], extensions: ['.json'] })).toBe(
      '/allowed/file.json'
    );

    expect(() => resolveSecureFile('', 'credential', { allowedRoots: ['/allowed'] })).toThrow('credential path must not be empty');

    mockFs.lstatSync.mockImplementationOnce(() => {
      throw new Error('lstat failed');
    });
    expect(() => resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'] })).toThrow(
      'Unable to inspect credential file.json: lstat failed'
    );

    mockFs.lstatSync.mockReturnValueOnce(stat({ isSymbolicLink: () => true }));
    expect(() => resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'] })).toThrow(
      'credential must not be a symbolic link'
    );

    mockFs.lstatSync.mockReturnValueOnce(stat({ isFile: () => false }));
    expect(() => resolveSecureFile('/allowed/dir.json', 'credential', { allowedRoots: ['/allowed'] })).toThrow(
      'credential must be a regular file'
    );

    expect(() =>
      resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'], expectedBasenames: ['service-account.json'] })
    ).toThrow('credential must use one of these file names: service-account.json');

    expect(() => resolveSecureFile('/allowed/file.txt', 'credential', { allowedRoots: ['/allowed'], extensions: ['.json'] })).toThrow(
      'credential must use one of these extensions: .json'
    );

    mockFs.lstatSync.mockReturnValueOnce(stat({ size: 100 }));
    expect(() => resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'], maxBytes: 10 })).toThrow(
      'credential is too large'
    );

    mockFs.accessSync.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => resolveSecureFile('/allowed/file.json', 'credential', { allowedRoots: ['/allowed'] })).toThrow(
      'Unable to read credential file file.json: denied'
    );
  });

  test('resolves secure directories and rejects unreadable directories', () => {
    mockFs.lstatSync.mockReturnValue(stat({ isDirectory: () => true, isFile: () => false }));
    expect(resolveSecureDirectory('/allowed/dir', 'releaseDirectory', ['/allowed'])).toBe('/allowed/dir');

    mockFs.lstatSync.mockReturnValueOnce(stat({ isDirectory: () => false, isFile: () => true }));
    expect(() => resolveSecureDirectory('/allowed/file', 'releaseDirectory', ['/allowed'])).toThrow(
      'releaseDirectory must be a directory'
    );

    mockFs.lstatSync.mockReturnValue(stat({ isDirectory: () => true, isFile: () => false }));
    mockFs.accessSync.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => resolveSecureDirectory('/allowed/dir', 'releaseDirectory', ['/allowed'])).toThrow(
      'Unable to read releaseDirectory directory dir: denied'
    );
  });

  test('validates service account JSON shape', () => {
    expect(() =>
      validateServiceAccountJsonPayload(
        JSON.stringify({
          type: 'service_account',
          project_id: 'p',
          client_email: 'bot@example.com',
          private_key: 'key',
        }),
        'serviceAccountJson'
      )
    ).not.toThrow();
    expect(() => validateServiceAccountJsonPayload('{', 'serviceAccountJson')).toThrow('serviceAccountJson must be valid JSON');
    expect(() => validateServiceAccountJsonPayload('[]', 'serviceAccountJson')).toThrow(
      'serviceAccountJson must be a service account JSON object'
    );
    expect(() => validateServiceAccountJsonPayload('{"type":"user"}', 'serviceAccountJson')).toThrow(
      'serviceAccountJson must have type "service_account"'
    );
    expect(() => validateServiceAccountJsonPayload('{"type":"service_account"}', 'serviceAccountJson')).toThrow(
      'serviceAccountJson is missing required field "project_id"'
    );
  });
});
