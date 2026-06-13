jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setFailed: jest.fn(),
  exportVariable: jest.fn(),
  setOutput: jest.fn(),
}));

jest.mock('fs', () => ({
  __esModule: true,
  accessSync: jest.fn(),
  constants: { R_OK: 4 },
  existsSync: jest.fn(),
  lstatSync: jest.fn(),
  mkdtempSync: jest.fn(),
  realpathSync: jest.fn(),
  rmSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    readFile: jest.fn(),
  },
}));

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
  writeFile: jest.fn(),
}));

jest.mock('p-timeout', () => ({
  __esModule: true,
  default: jest.fn(async (promise: Promise<unknown>) => promise),
}));

jest.mock('../src/edits', () => ({
  runUpload: jest.fn(),
}));

jest.mock('../src/input-validation', () => ({
  validateInAppUpdatePriority: jest.fn(),
  validateReleaseFiles: jest.fn(),
  validateStatus: jest.fn(),
  validateUserFraction: jest.fn(),
}));

jest.mock('../src/utils/io-utils', () => ({
  findReleaseFiles: jest.fn(),
}));

jest.mock('../src/signing', () => ({
  signApkFile: jest.fn(),
  signAabFile: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  d: jest.fn(),
  e: jest.fn(),
  i: jest.fn(),
  w: jest.fn(),
}));

jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

jest.mock('../src/whatsnew', () => ({
  readLocalizedReleaseNotes: jest.fn(),
}));

import * as core from '@actions/core';
import * as fs from 'fs';
import { unlink, writeFile } from 'fs/promises';
import pTimeout from 'p-timeout';
import { runUpload as runUploadEdit } from '../src/edits';
import { validateInAppUpdatePriority, validateReleaseFiles, validateStatus, validateUserFraction } from '../src/input-validation';
import * as ioUtils from '../src/utils/io-utils';
import { signAabFile, signApkFile } from '../src/signing';
import * as logger from '../src/utils/logger';
import { exec } from '@actions/exec';
import { readLocalizedReleaseNotes } from '../src/whatsnew';
import { __testables, run, uploadRun } from '../src/main';

type InputMap = Record<string, string | undefined>;
const VALID_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'project-id',
  client_email: 'bot@example.com',
  private_key: 'private-key',
});
const TEMP_SERVICE_ACCOUNT_FILE = '/tmp/android-support-service-account-test/serviceAccountJson.json';
const TEMP_SIGNING_KEY_FILE = '/tmp/android-support-signing-test/signingKey.jks';

function fileStat(overrides: Partial<{ isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean; size: number }> = {}) {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 1024,
    ...overrides,
  };
}

function setInputs(inputs: InputMap) {
  (core.getInput as jest.Mock).mockImplementation((name: string) => inputs[name] ?? '');
}

describe('main module', () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEBUG_ACTION;
    process.env.RUNNER_TEMP = '/tmp';
    setInputs({});
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.accessSync as jest.Mock).mockReturnValue(undefined);
    (fs.lstatSync as jest.Mock).mockReturnValue(fileStat());
    (fs.mkdtempSync as jest.Mock).mockImplementation((prefix: string) => `${prefix}test`);
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => filePath);
    (fs.rmSync as jest.Mock).mockReturnValue(undefined);
    (writeFile as jest.Mock).mockResolvedValue(undefined);
    (unlink as jest.Mock).mockResolvedValue(undefined);
    (fs.promises.readFile as unknown as jest.Mock).mockResolvedValue(VALID_SERVICE_ACCOUNT_JSON);
    (pTimeout as jest.Mock).mockImplementation(async (promise: Promise<unknown>) => promise);
    (runUploadEdit as jest.Mock).mockResolvedValue(undefined);
    (validateInAppUpdatePriority as jest.Mock).mockResolvedValue(undefined);
    (validateReleaseFiles as jest.Mock).mockResolvedValue(['./__tests__/releasefiles/release.aab']);
    (validateStatus as jest.Mock).mockResolvedValue(undefined);
    (validateUserFraction as jest.Mock).mockResolvedValue(undefined);
    (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue(undefined);
    (signApkFile as jest.Mock).mockResolvedValue('/releases/app-signed.apk');
    (signAabFile as jest.Mock).mockResolvedValue('/releases/app-signed.aab');
    (exec as jest.Mock).mockResolvedValue(0);
    (readLocalizedReleaseNotes as jest.Mock).mockResolvedValue([{ language: 'en-US', text: 'localized' }]);
  });

  afterAll(() => {
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
  });

  describe('run', () => {
    test('routes to upload flow', async () => {
      setInputs({
        type: 'upload',
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });

      await run();

      expect(runUploadEdit).toHaveBeenCalledTimes(1);
    });

    test('routes to sign flow', async () => {
      setInputs({
        type: 'sign',
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith('No release files (.apk or .aab) could be found.');
    });

    test('fails for unknown type', async () => {
      setInputs({ type: 'unknown' });
      await run();
      expect(core.setFailed).toHaveBeenCalledWith('Unknown type: unknown');
    });

    test('handles Error in run', async () => {
      (core.getInput as jest.Mock).mockImplementation((name: string) => {
        if (name === 'type') {
          throw new Error('run blew up');
        }
        return undefined;
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith('run blew up');
    });

    test('handles unknown thrown value in run', async () => {
      (core.getInput as jest.Mock).mockImplementation((name: string) => {
        if (name === 'type') {
          throw 'boom';
        }
        return undefined;
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith('boom');
    });

    test('does not own service account cleanup at the router level', async () => {
      setInputs({ type: 'unknown', serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON });

      await run();

      expect(unlink).not.toHaveBeenCalled();
    });
  });

  describe('uploadRun', () => {
    test('runs upload flow with parsed options and direct release notes', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFile: './__tests__/releasefiles/release.aab',
        track: 'production',
        inAppUpdatePriority: '3',
        userFraction: '0.5',
        status: 'inProgress',
        whatsNewDirectory: './__tests__/whatsnew',
        mappingFile: './mapping.txt',
        debugSymbols: './symbols.zip',
        changesNotSentForReview: 'true',
        existingEditId: 'edit-123',
        releaseName: 'Release Name',
        releaseNotesSource: 'none',
        releaseNotes: 'inline release notes',
      });

      await uploadRun();

      expect(validateReleaseFiles).toHaveBeenCalledWith(['./__tests__/releasefiles/release.aab']);
      expect(validateUserFraction).toHaveBeenCalledWith(0.5);
      expect(validateStatus).toHaveBeenCalledWith('inProgress', true);
      expect(validateInAppUpdatePriority).toHaveBeenCalledWith(3);
      expect(runUploadEdit).toHaveBeenCalledWith(
        'com.app',
        'production',
        3,
        0.5,
        './__tests__/whatsnew',
        './mapping.txt',
        './symbols.zip',
        'Release Name',
        true,
        'edit-123',
        'inProgress',
        ['./__tests__/releasefiles/release.aab'],
        [{ language: 'en-US', text: 'inline release notes' }]
      );
      expect(logger.w).toHaveBeenCalledWith(
        "WARNING!! 'releaseFile' is deprecated and will be removed in a future release. Please migrate to 'releaseFiles'"
      );
      expect(pTimeout).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(TEMP_SERVICE_ACCOUNT_FILE);
    });

    test('fails before upload when provided optional files are missing', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab,./__tests__/releasefiles/release.apk',
        track: 'production',
        status: 'completed',
        whatsNewDirectory: './missing-whatsnew',
        mappingFile: './missing-mapping.txt',
        debugSymbols: './missing-symbols.zip',
        releaseNotesSource: 'file',
        releaseNotesPath: './release-notes.txt',
      });
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await uploadRun();

      expect(validateReleaseFiles).toHaveBeenCalledWith(['./__tests__/releasefiles/release.aab', './__tests__/releasefiles/release.apk']);
      expect(validateUserFraction).toHaveBeenCalledWith(undefined);
      expect(validateStatus).toHaveBeenCalledWith('completed', false);
      expect(validateInAppUpdatePriority).toHaveBeenCalledWith(undefined);
      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("Unable to find 'whatsnew' directory @ ./missing-whatsnew");
    });

    test('fails before upload when provided mapping file is missing', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        mappingFile: './missing-mapping.txt',
      });
      (fs.existsSync as jest.Mock).mockImplementation((filePath: string) => filePath !== './missing-mapping.txt');

      await uploadRun();

      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("Unable to find 'mappingFile' @ ./missing-mapping.txt");
    });

    test('fails before upload when provided debug symbols are missing', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        debugSymbols: './missing-symbols.zip',
      });
      (fs.existsSync as jest.Mock).mockImplementation((filePath: string) => filePath !== './missing-symbols.zip');

      await uploadRun();

      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("Unable to find 'debugSymbols' @ ./missing-symbols.zip");
    });

    test('preloads localized whatsnew notes before upload', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        whatsNewDirectory: './__tests__/whatsnew',
      });

      await uploadRun();

      expect(readLocalizedReleaseNotes).toHaveBeenCalledWith('./__tests__/whatsnew');
      expect(runUploadEdit).toHaveBeenCalledWith(
        'com.app',
        'production',
        undefined,
        undefined,
        './__tests__/whatsnew',
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'completed',
        ['./__tests__/releasefiles/release.aab'],
        [{ language: 'en-US', text: 'localized' }]
      );
    });

    test('trims and removes empty releaseFiles entries before validation', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        releaseFiles: ' ./__tests__/releasefiles/release.aab, ,\t,./__tests__/releasefiles/release.apk,   ',
        track: 'production',
        status: 'completed',
      });

      await uploadRun();

      expect(validateReleaseFiles).toHaveBeenCalledWith(['./__tests__/releasefiles/release.aab', './__tests__/releasefiles/release.apk']);
    });

    test('reports missing release files before upload', async () => {
      setInputs({
        serviceAccountJson: '/tmp/service-account.json',
        packageName: 'com.app',
        track: 'production',
        status: 'completed',
      });
      (validateReleaseFiles as jest.Mock).mockRejectedValueOnce(new Error("You must provide 'releaseFiles' in your configuration"));

      await uploadRun();

      expect(validateReleaseFiles).toHaveBeenCalledWith(undefined);
      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("You must provide 'releaseFiles' in your configuration");
    });

    test('dry-run validates inputs but skips the Play API upload', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        dryRun: 'true',
      });

      await uploadRun();

      expect(validateReleaseFiles).toHaveBeenCalled();
      expect(validateStatus).toHaveBeenCalledWith('completed', false);
      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith('dryRun', 'true');
    });

    test('handles Error in upload flow', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });
      (validateStatus as jest.Mock).mockRejectedValue(new Error('status invalid'));

      await uploadRun();

      expect(core.setFailed).toHaveBeenCalledWith('status invalid');
      expect(unlink).toHaveBeenCalledWith(TEMP_SERVICE_ACCOUNT_FILE);
    });

    test('handles non-Error in upload flow', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });
      (validateUserFraction as jest.Mock).mockRejectedValue('bad-value');

      await uploadRun();

      expect(core.setFailed).toHaveBeenCalledWith('bad-value');
    });

    test('rejects malformed numeric input strings before upload', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        userFraction: '0.5abc',
        inAppUpdatePriority: '3abc',
      });

      await uploadRun();

      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("'userFraction' must be a valid number. Got 0.5abc");
    });

    test('rejects malformed in-app update priority strings before upload', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
        inAppUpdatePriority: '3abc',
      });

      await uploadRun();

      expect(runUploadEdit).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith("'inAppUpdatePriority' must be a valid integer. Got 3abc");
    });

    test('propagates pTimeout failures and still cleans up credentials', async () => {
      setInputs({
        serviceAccountJsonPlainText: VALID_SERVICE_ACCOUNT_JSON,
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });
      (pTimeout as jest.Mock).mockRejectedValueOnce(new Error('upload timed out'));

      await uploadRun();

      expect(runUploadEdit).toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith('upload timed out');
      expect(unlink).toHaveBeenCalledWith(TEMP_SERVICE_ACCOUNT_FILE);
    });
  });

  describe('__testables.validateServiceAccountJson', () => {
    test('rejects when both credential options are present', async () => {
      await expect(__testables.validateServiceAccountJson(VALID_SERVICE_ACCOUNT_JSON, '/tmp/service.json')).rejects.toThrow(
        "Provide only one of 'serviceAccountJsonPlainText' or 'serviceAccountJson'"
      );
      expect(writeFile).not.toHaveBeenCalled();
      expect(core.exportVariable).not.toHaveBeenCalled();
    });

    test('writes plain text credentials to a generated temp file', async () => {
      await __testables.validateServiceAccountJson(VALID_SERVICE_ACCOUNT_JSON, undefined);

      expect(writeFile).toHaveBeenCalledWith(
        TEMP_SERVICE_ACCOUNT_FILE,
        VALID_SERVICE_ACCOUNT_JSON,
        expect.objectContaining({ encoding: 'utf8', mode: 0o600 })
      );
      expect(core.exportVariable).toHaveBeenCalledWith('GOOGLE_APPLICATION_CREDENTIALS', TEMP_SERVICE_ACCOUNT_FILE);
    });

    test('exports file credentials when plain text credentials are not provided', async () => {
      await __testables.validateServiceAccountJson(undefined, '/tmp/service.json');
      expect(core.exportVariable).toHaveBeenCalledWith('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/service.json');
    });

    test('rejects malformed service account JSON before exporting credentials', async () => {
      await expect(__testables.validateServiceAccountJson('{"type":"service_account"}', undefined)).rejects.toThrow(
        'serviceAccountJsonPlainText is missing required field "project_id"'
      );
      expect(core.exportVariable).not.toHaveBeenCalled();
    });

    test('rejects when neither credential source is provided', async () => {
      await expect(__testables.validateServiceAccountJson(undefined, undefined)).rejects.toThrow(
        "You must provide one of 'serviceAccountJsonPlainText' or 'serviceAccountJson' to use this action"
      );
    });
  });

  describe('__testables.cleanupServiceAccountJsonFile', () => {
    test('does nothing when no generated credential file exists', async () => {
      await __testables.cleanupServiceAccountJsonFile('');

      expect(logger.d).toHaveBeenCalledWith('No generated service account json file to clean up');
      expect(unlink).not.toHaveBeenCalled();
    });

    test('ignores already removed temp credential file', async () => {
      await __testables.validateServiceAccountJson(VALID_SERVICE_ACCOUNT_JSON, undefined);
      jest.clearAllMocks();
      (unlink as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await __testables.cleanupServiceAccountJsonFile();

      expect(logger.d).toHaveBeenCalledWith('Service account json file already removed: serviceAccountJson.json');
    });

    test('logs cleanup failures without throwing', async () => {
      (unlink as jest.Mock).mockRejectedValueOnce(new Error('locked'));

      await __testables.cleanupServiceAccountJsonFile(TEMP_SERVICE_ACCOUNT_FILE);

      expect(logger.w).toHaveBeenCalledWith('Failed to clean up service account json file serviceAccountJson.json: locked');
    });
  });

  describe('__testables.signRun', () => {
    test('returns early in debug mode', async () => {
      process.env.DEBUG_ACTION = 'true';
      await __testables.signRun();
      expect(logger.d).toHaveBeenCalledWith('DEBUG FLAG DETECTED, SHORTCUTTING ACTION.');
    });

    test('fails when no release file is found', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue(undefined);

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith('No release files (.apk or .aab) could be found.');
    });

    test('signs a single apk and exports single-file outputs', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
        keyPassword: 'key-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'app.apk' }]);

      await __testables.signRun();

      expect(fs.writeFileSync).toHaveBeenCalledWith(TEMP_SIGNING_KEY_FILE, 'a2V5', { encoding: 'base64', mode: 0o600 });
      expect(signApkFile).toHaveBeenCalledWith('/releases/app.apk', TEMP_SIGNING_KEY_FILE, 'alias', 'store-pass', 'key-pass');
      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/android-support-signing-test', { recursive: true, force: true });
      expect(core.exportVariable).toHaveBeenCalledWith('SIGNED_RELEASE_FILE_0', '/releases/app-signed.apk');
      expect(core.setOutput).toHaveBeenCalledWith('signedReleaseFile0', '/releases/app-signed.apk');
      expect(core.exportVariable).toHaveBeenCalledWith('SIGNED_RELEASE_FILE', '/releases/app-signed.apk');
      expect(core.setOutput).toHaveBeenCalledWith('signedReleaseFile', '/releases/app-signed.apk');
    });

    test('signs multiple artifacts and handles invalid extension', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'app.apk' }, { name: 'bundle.aab' }, { name: 'bad.txt' }]);

      await __testables.signRun();

      expect(signApkFile).toHaveBeenCalledTimes(1);
      expect(signAabFile).toHaveBeenCalledTimes(1);
      expect(core.setFailed).toHaveBeenCalledWith('No valid release file to sign: /releases/bad.txt');
      expect(core.exportVariable).not.toHaveBeenCalledWith('SIGNED_RELEASE_FILE_2', '');
      expect(core.setOutput).not.toHaveBeenCalledWith('signedReleaseFile2', '');
      expect(core.exportVariable).not.toHaveBeenCalledWith('NOF_SIGNED_RELEASE_FILES', '3');
    });

    test('signs multiple valid artifacts and exports aggregate outputs only', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'app.apk' }, { name: 'bundle.aab' }]);

      await __testables.signRun();

      expect(core.exportVariable).toHaveBeenCalledWith('SIGNED_RELEASE_FILES', '/releases/app-signed.apk:/releases/app-signed.aab');
      expect(core.setOutput).toHaveBeenCalledWith('signedReleaseFiles', '/releases/app-signed.apk:/releases/app-signed.aab');
      expect(core.exportVariable).toHaveBeenCalledWith('NOF_SIGNED_RELEASE_FILES', '2');
      expect(core.setOutput).toHaveBeenCalledWith('nofSignedReleaseFiles', '2');
      expect(core.setOutput).not.toHaveBeenCalledWith('signedReleaseFile', expect.any(String));
    });

    test('reports signer promise rejection without exporting outputs', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'app.apk' }]);
      (signApkFile as jest.Mock).mockRejectedValueOnce(new Error('zipalign failed'));

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith('zipalign failed');
      expect(core.setOutput).not.toHaveBeenCalledWith('signedReleaseFiles', expect.any(String));
    });

    test('logs temporary signing key cleanup failures', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'app.apk' }]);
      (fs.rmSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('cleanup denied');
      });

      await __testables.signRun();

      expect(logger.w).toHaveBeenCalledWith('Failed to clean up temporary signing key directory: cleanup denied');
    });

    test('reports aab signer promise rejection without exporting outputs', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockReturnValue([{ name: 'bundle.aab' }]);
      (signAabFile as jest.Mock).mockRejectedValueOnce(new Error('jarsigner failed'));

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith('jarsigner failed');
      expect(core.setOutput).not.toHaveBeenCalledWith('signedReleaseFiles', expect.any(String));
    });

    test.each(['releaseDirectory', 'signingKeyBase64', 'alias', 'keyStorePassword'])('reports missing required sign input %s', async inputName => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
        [inputName]: '',
      });

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith(`Missing required input '${inputName}'`);
      expect(ioUtils.findReleaseFiles).not.toHaveBeenCalled();
    });

    test('handles Error thrown while signing', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockImplementation(() => {
        throw new Error('sign failed');
      });

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith('sign failed');
    });

    test('handles non-Error thrown while signing', async () => {
      setInputs({
        releaseDirectory: '/releases',
        signingKeyBase64: 'a2V5',
        alias: 'alias',
        keyStorePassword: 'store-pass',
      });
      (ioUtils.findReleaseFiles as jest.Mock).mockImplementation(() => {
        throw 'panic';
      });

      await __testables.signRun();

      expect(core.setFailed).toHaveBeenCalledWith('panic');
    });
  });

  describe('__testables.getReleaseNotes', () => {
    test('returns inline content directly', async () => {
      await expect(__testables.getReleaseNotes('none', undefined, 'inline')).resolves.toBe('inline');
    });

    test('reads release notes from file', async () => {
      (fs.promises.readFile as unknown as jest.Mock).mockResolvedValue('file-based');
      await expect(__testables.getReleaseNotes('file', './notes.md', undefined)).resolves.toBe('file-based');
    });

    test('handles file read failure', async () => {
      (fs.promises.readFile as unknown as jest.Mock).mockRejectedValue(new Error('no file'));
      await expect(__testables.getReleaseNotes('file', './missing.md', undefined)).rejects.toThrow(
        'Failed to read release notes file missing.md: no file'
      );
    });

    test('handles file read failure with non-Error value', async () => {
      (fs.promises.readFile as unknown as jest.Mock).mockRejectedValue('missing');
      await expect(__testables.getReleaseNotes('file', './missing.md', undefined)).rejects.toThrow(
        'Failed to read release notes file missing.md: missing'
      );
      expect(logger.e).toHaveBeenCalledWith('Failed to read release notes file: missing.md. Error: missing');
    });

    test('fails when file release notes source has no path', async () => {
      await expect(__testables.getReleaseNotes('file', undefined, undefined)).rejects.toThrow(
        "releaseNotesSource is 'file' but releaseNotesPath was not provided."
      );
    });

    test('generates notes from git commits and logs stderr', async () => {
      (exec as jest.Mock).mockImplementation(
        (_cmd: string, _args: string[], options: { listeners: { stdout: (data: Buffer) => void; stderr: (data: Buffer) => void } }) => {
          options.listeners.stdout(Buffer.from('feat: a\nfix: b'));
          options.listeners.stderr(Buffer.from('warning'));
        }
      );

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBe('feat: a\nfix: b');
      expect(logger.w).toHaveBeenCalledWith('Git command stderr: warning');
    });

    test('generates notes from git commits without stderr', async () => {
      (exec as jest.Mock).mockImplementation(
        (_cmd: string, _args: string[], options: { listeners: { stdout: (data: Buffer) => void; stderr: (data: Buffer) => void } }) => {
          options.listeners.stdout(Buffer.from('feat: clean output'));
        }
      );

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBe('feat: clean output');
    });

    test('handles git command failure', async () => {
      (exec as jest.Mock).mockRejectedValue(new Error('git unavailable'));

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).rejects.toThrow(
        'Failed to generate release notes from git commits: git unavailable'
      );
    });

    test('handles git command failure with non-Error value', async () => {
      (exec as jest.Mock).mockRejectedValue('git failed');

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).rejects.toThrow(
        'Failed to generate release notes from git commits: git failed'
      );
      expect(logger.e).toHaveBeenCalledWith('Failed to get git commits: git failed');
    });

    test('returns undefined for unsupported source', async () => {
      await expect(__testables.getReleaseNotes('none', undefined, undefined)).resolves.toBeUndefined();
    });
  });
});
