jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

jest.mock('@actions/io', () => ({
  which: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  d: jest.fn(),
  e: jest.fn(),
}));

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    existsSync: jest.fn(),
  },
  existsSync: jest.fn(),
}));

import { exec } from '@actions/exec';
import * as io from '@actions/io';
import * as logger from '../src/utils/logger';
import { signAabFile, signApkFile } from '../src/signing';
import fs from 'fs';

describe('signing', () => {
  const originalAndroidHome = process.env.ANDROID_HOME;
  const originalBuildToolsVersion = process.env.BUILD_TOOLS_VERSION;

  beforeEach(() => {
    process.env.ANDROID_HOME = '/android-sdk';
    process.env.BUILD_TOOLS_VERSION = '35.0.0';
    (exec as jest.Mock).mockResolvedValue(0);
    (io.which as jest.Mock).mockResolvedValue('/usr/bin/jarsigner');
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.ANDROID_HOME = originalAndroidHome;
    process.env.BUILD_TOOLS_VERSION = originalBuildToolsVersion;
  });

  test('signApkFile signs and verifies with key password', async () => {
    const result = await signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass', 'keypass');

    expect(result).toBe('/tmp/app-signed.apk');
    expect(exec).toHaveBeenNthCalledWith(1, '"/android-sdk/build-tools/35.0.0/zipalign"', ['-c', '-v', '4', '/tmp/app.apk']);
    expect(exec).toHaveBeenNthCalledWith(2, '"cp"', ['/tmp/app.apk', '/tmp/app-aligned.apk']);
    expect(exec).toHaveBeenNthCalledWith(
      3,
      '"/android-sdk/build-tools/35.0.0/apksigner"',
      [
        'sign',
        '--ks',
        '/tmp/key.jks',
        '--ks-key-alias',
        'alias',
        '--ks-pass',
        'pass:storepass',
        '--out',
        '/tmp/app-signed.apk',
        '--key-pass',
        'pass:keypass',
        '/tmp/app-aligned.apk',
      ]
    );
    expect(exec).toHaveBeenNthCalledWith(4, '"/android-sdk/build-tools/35.0.0/apksigner"', ['verify', '/tmp/app-signed.apk']);
  });

  test('signApkFile logs error when build tools path is missing', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    await signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass');

    expect(logger.e).toHaveBeenCalledWith('Couldnt find the Android build tools @ /android-sdk/build-tools/35.0.0');
  });

  test('signApkFile uses default build tools version when env is missing', async () => {
    delete process.env.BUILD_TOOLS_VERSION;

    await signApkFile('/tmp/app.apk', '/tmp/key.jks', 'alias', 'storepass');

    expect(exec).toHaveBeenNthCalledWith(1, '"/android-sdk/build-tools/33.0.0/zipalign"', ['-c', '-v', '4', '/tmp/app.apk']);
  });

  test('signAabFile signs with and without key password', async () => {
    await expect(signAabFile('/tmp/app.aab', '/tmp/key.jks', 'alias', 'storepass')).resolves.toBe('/tmp/app.aab');
    expect(io.which).toHaveBeenCalledWith('jarsigner', true);
    expect(exec).toHaveBeenNthCalledWith(1, '"/usr/bin/jarsigner"', ['-keystore', '/tmp/key.jks', '-storepass', 'storepass', '/tmp/app.aab', 'alias']);

    await expect(signAabFile('/tmp/app2.aab', '/tmp/key.jks', 'alias', 'storepass', 'keypass')).resolves.toBe('/tmp/app2.aab');
    expect(exec).toHaveBeenNthCalledWith(2, '"/usr/bin/jarsigner"', [
      '-keystore',
      '/tmp/key.jks',
      '-storepass',
      'storepass',
      '-keypass',
      'keypass',
      '/tmp/app2.aab',
      'alias',
    ]);
  });
});
