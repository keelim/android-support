jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  setSecret: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  d: jest.fn(),
  e: jest.fn(),
}));

const mockExistsSync = jest.fn();
const mockAccessSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockRealpathSync = jest.fn();

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    accessSync: mockAccessSync,
    constants: { X_OK: 1 },
    copyFileSync: mockCopyFileSync,
    existsSync: mockExistsSync,
    realpathSync: mockRealpathSync,
  },
  accessSync: mockAccessSync,
  constants: { X_OK: 1 },
  copyFileSync: mockCopyFileSync,
  existsSync: mockExistsSync,
  realpathSync: mockRealpathSync,
}));

import { exec } from '@actions/exec';
import * as core from '@actions/core';
import * as logger from '../src/utils/logger';
import { signAabFile, signApkFile } from '../src/signing';
import fs from 'fs';

function expectExecEnv(callNumber: number, expectedEnv: Record<string, string>): void {
  const call = (exec as jest.MockedFunction<typeof exec>).mock.calls[callNumber - 1];
  if (!call) {
    throw new Error(`Expected exec call ${callNumber} to exist`);
  }
  expect(call[2]?.env).toEqual(expect.objectContaining(expectedEnv));
}

describe('signing', () => {
  const originalAndroidHome = process.env.ANDROID_HOME;
  const originalBuildToolsVersion = process.env.BUILD_TOOLS_VERSION;
  const originalJavaHome = process.env.JAVA_HOME;

  beforeEach(() => {
    process.env.ANDROID_HOME = '/android-sdk';
    process.env.BUILD_TOOLS_VERSION = '35.0.0';
    process.env.JAVA_HOME = '/jdk';
    (exec as jest.Mock).mockResolvedValue(0);
    (fs.accessSync as jest.Mock).mockReturnValue(undefined);
    (fs.copyFileSync as jest.Mock).mockReturnValue(undefined);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => filePath);
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.ANDROID_HOME = originalAndroidHome;
    process.env.BUILD_TOOLS_VERSION = originalBuildToolsVersion;
    process.env.JAVA_HOME = originalJavaHome;
  });

  test('signApkFile signs and verifies with key password', async () => {
    const result = await signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass', 'keypass');

    expect(result).toBe('/tmp/app-signed.apk');
    expect(exec).toHaveBeenNthCalledWith(1, '"/android-sdk/build-tools/35.0.0/zipalign"', ['-c', '-v', '4', '/tmp/app.apk']);
    expect(exec).toHaveBeenNthCalledWith(
      2,
      '"/android-sdk/build-tools/35.0.0/apksigner"',
      [
        'sign',
        '--ks',
        '/tmp/key.jks',
        '--ks-key-alias',
        'alias',
        '--ks-pass',
        'env:ANDROID_SUPPORT_KEYSTORE_PASSWORD',
        '--out',
        '/tmp/app-signed.apk',
        '--key-pass',
        'env:ANDROID_SUPPORT_KEY_PASSWORD',
        '/tmp/app-aligned.apk',
      ],
      expect.any(Object)
    );
    expectExecEnv(2, {
      ANDROID_SUPPORT_KEYSTORE_PASSWORD: 'storepass',
      ANDROID_SUPPORT_KEY_PASSWORD: 'keypass',
    });
    expect(exec).toHaveBeenNthCalledWith(3, '"/android-sdk/build-tools/35.0.0/apksigner"', ['verify', '/tmp/app-signed.apk']);
    expect(fs.copyFileSync).toHaveBeenCalledWith('/tmp/app.apk', '/tmp/app-aligned.apk');
    expect(core.setSecret).toHaveBeenCalledWith('storepass');
    expect(core.setSecret).toHaveBeenCalledWith('keypass');
  });

  test('signApkFile logs error when build tools path is missing', async () => {
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath === '/android-sdk/build-tools/35.0.0') throw new Error('missing build tools');
      return filePath;
    });

    await expect(signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow(
      'missing build tools'
    );

    expect(exec).not.toHaveBeenCalled();
    expect(logger.e).not.toHaveBeenCalled();
  });

  test('signApkFile rejects non-executable build tools', async () => {
    (fs.accessSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error('not executable');
    });

    await expect(signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow(
      'Unable to execute zipalign zipalign: not executable'
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test('signApkFile fails clearly when ANDROID_HOME is missing', async () => {
    delete process.env.ANDROID_HOME;

    await expect(signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow(
      'ANDROID_HOME must be set to an absolute Android SDK path to sign APK files.'
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test('signApkFile rejects suspicious build tools versions', async () => {
    process.env.BUILD_TOOLS_VERSION = '../malicious';

    await expect(signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow(
      'BUILD_TOOLS_VERSION must be a version string such as 35.0.0'
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test('signApkFile uses default build tools version when env is missing', async () => {
    delete process.env.BUILD_TOOLS_VERSION;

    await signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass');

    expect(exec).toHaveBeenNthCalledWith(1, '"/android-sdk/build-tools/33.0.0/zipalign"', ['-c', '-v', '4', '/tmp/app.apk']);
  });

  test('signAabFile signs with and without key password', async () => {
    await expect(signAabFile('/tmp/app.aab', '/tmp/key.jks', 'alias', 'storepass')).resolves.toBe('/tmp/app.aab');
    expect(exec).toHaveBeenNthCalledWith(
      1,
      '"/jdk/bin/jarsigner"',
      ['-keystore', '/tmp/key.jks', '-storepass:env', 'ANDROID_SUPPORT_KEYSTORE_PASSWORD', '/tmp/app.aab', 'alias'],
      expect.any(Object)
    );
    expectExecEnv(1, {
      ANDROID_SUPPORT_KEYSTORE_PASSWORD: 'storepass',
    });
    expect(exec).toHaveBeenNthCalledWith(2, '"/jdk/bin/jarsigner"', ['-verify', '-certs', '-verbose', '/tmp/app.aab']);

    await expect(signAabFile('/tmp/app2.aab', '/tmp/key.jks', 'alias', 'storepass', 'keypass')).resolves.toBe('/tmp/app2.aab');
    expect(exec).toHaveBeenNthCalledWith(
      3,
      '"/jdk/bin/jarsigner"',
      [
        '-keystore',
        '/tmp/key.jks',
        '-storepass:env',
        'ANDROID_SUPPORT_KEYSTORE_PASSWORD',
        '-keypass:env',
        'ANDROID_SUPPORT_KEY_PASSWORD',
        '/tmp/app2.aab',
        'alias',
      ],
      expect.any(Object)
    );
    expectExecEnv(3, {
      ANDROID_SUPPORT_KEYSTORE_PASSWORD: 'storepass',
      ANDROID_SUPPORT_KEY_PASSWORD: 'keypass',
    });
    expect(exec).toHaveBeenNthCalledWith(4, '"/jdk/bin/jarsigner"', ['-verify', '-certs', '-verbose', '/tmp/app2.aab']);
  });

  test('signAabFile propagates jarsigner lookup failures', async () => {
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath === '/jdk/bin/jarsigner') throw new Error('jarsigner missing');
      return filePath;
    });

    await expect(signAabFile('/tmp/app.aab', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow('jarsigner missing');
    expect(exec).not.toHaveBeenCalled();
  });

  test('signAabFile requires JAVA_HOME instead of PATH lookup', async () => {
    delete process.env.JAVA_HOME;

    await expect(signAabFile('/tmp/app.aab', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow(
      'JAVA_HOME must be set to an absolute JDK path to use jarsigner.'
    );
    expect(exec).not.toHaveBeenCalled();
  });

  test('signAabFile propagates jarsigner exec failures', async () => {
    (exec as jest.Mock).mockRejectedValueOnce(new Error('jarsigner failed'));

    await expect(signAabFile('/tmp/app.aab', '/tmp/key.jks', 'alias', 'storepass')).rejects.toThrow('jarsigner failed');
  });
});
