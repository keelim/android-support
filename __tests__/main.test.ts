jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setFailed: jest.fn(),
  exportVariable: jest.fn(),
  setOutput: jest.fn(),
}));

jest.mock('fs', () => ({
  __esModule: true,
  existsSync: jest.fn(),
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

import * as core from '@actions/core';
import * as fs from 'fs';
import { unlink, writeFile } from 'fs/promises';
import pTimeout from 'p-timeout';
import { runUpload as runUploadEdit } from '../src/edits';
import {
  validateInAppUpdatePriority,
  validateReleaseFiles,
  validateStatus,
  validateUserFraction,
} from '../src/input-validation';
import * as ioUtils from '../src/utils/io-utils';
import { signAabFile, signApkFile } from '../src/signing';
import * as logger from '../src/utils/logger';
import { exec } from '@actions/exec';
import { __testables, run, uploadRun } from '../src/main';

type InputMap = Record<string, string | undefined>;

function setInputs(inputs: InputMap) {
  (core.getInput as jest.Mock).mockImplementation((name: string) => inputs[name]);
}

describe('main module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEBUG_ACTION;
    setInputs({});
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (writeFile as jest.Mock).mockResolvedValue(undefined);
    (unlink as jest.Mock).mockResolvedValue(undefined);
    ((fs.promises.readFile as unknown) as jest.Mock).mockResolvedValue('notes-from-file');
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
  });

  describe('run', () => {
    test('routes to upload flow', async () => {
      setInputs({
        type: 'upload',
        serviceAccountJsonPlainText: '{}',
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

      expect(core.setFailed).toHaveBeenCalledWith('Unknown error occurred.');
    });

    test('cleans up service account file in finally when provided', async () => {
      setInputs({ type: 'unknown', serviceAccountJsonPlainText: '{}' });

      await run();

      expect(logger.d).toHaveBeenCalledWith('Cleaning up service account json file');
      expect(unlink).toHaveBeenCalledWith('./serviceAccountJson.json');
    });
  });

  describe('uploadRun', () => {
    test('runs upload flow with parsed options and direct release notes', async () => {
      setInputs({
        serviceAccountJsonPlainText: '{}',
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
      expect(unlink).toHaveBeenCalledWith('./serviceAccountJson.json');
    });

    test('uses file-based release notes and warns for missing optional files', async () => {
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

      expect(validateReleaseFiles).toHaveBeenCalledWith([
        './__tests__/releasefiles/release.aab',
        './__tests__/releasefiles/release.apk',
      ]);
      expect(validateUserFraction).toHaveBeenCalledWith(undefined);
      expect(validateStatus).toHaveBeenCalledWith('completed', false);
      expect(validateInAppUpdatePriority).toHaveBeenCalledWith(undefined);
      expect(runUploadEdit).toHaveBeenCalledWith(
        'com.app',
        'production',
        undefined,
        undefined,
        './missing-whatsnew',
        './missing-mapping.txt',
        './missing-symbols.zip',
        undefined,
        false,
        undefined,
        'completed',
        ['./__tests__/releasefiles/release.aab'],
        [{ language: 'en-US', text: 'notes-from-file' }]
      );
      expect(logger.w).toHaveBeenCalledWith("Unable to find 'whatsnew' directory @ ./missing-whatsnew");
      expect(logger.w).toHaveBeenCalledWith("Unable to find 'mappingFile' @ ./missing-mapping.txt");
      expect(logger.w).toHaveBeenCalledWith("Unable to find 'debugSymbols' @ ./missing-symbols.zip");
    });

    test('handles Error in upload flow', async () => {
      setInputs({
        serviceAccountJsonPlainText: '{}',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });
      (validateStatus as jest.Mock).mockRejectedValue(new Error('status invalid'));

      await uploadRun();

      expect(core.setFailed).toHaveBeenCalledWith('status invalid');
      expect(unlink).toHaveBeenCalledWith('./serviceAccountJson.json');
    });

    test('handles non-Error in upload flow', async () => {
      setInputs({
        serviceAccountJsonPlainText: '{}',
        packageName: 'com.app',
        releaseFiles: './__tests__/releasefiles/release.aab',
        track: 'production',
        status: 'completed',
      });
      (validateUserFraction as jest.Mock).mockRejectedValue('bad-value');

      await uploadRun();

      expect(core.setFailed).toHaveBeenCalledWith('Unknown error occurred.');
    });
  });

  describe('__testables.validateServiceAccountJson', () => {
    test('prefers plain text credentials when both credential options are present', async () => {
      await __testables.validateServiceAccountJson('{"client_email":"a"}', '/tmp/service.json');

      expect(logger.w).toHaveBeenCalledWith(
        "Both 'serviceAccountJsonPlainText' and 'serviceAccountJson' were provided! 'serviceAccountJson' will be ignored."
      );
      expect(writeFile).toHaveBeenCalledWith('./serviceAccountJson.json', '{"client_email":"a"}', { encoding: 'utf8' });
      expect(core.exportVariable).toHaveBeenCalledWith('GOOGLE_APPLICATION_CREDENTIALS', './serviceAccountJson.json');
    });

    test('exports file credentials when plain text credentials are not provided', async () => {
      await __testables.validateServiceAccountJson(undefined, '/tmp/service.json');
      expect(core.exportVariable).toHaveBeenCalledWith('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/service.json');
    });

    test('rejects when neither credential source is provided', async () => {
      await expect(__testables.validateServiceAccountJson(undefined, undefined)).rejects.toBe(
        "You must provide one of 'serviceAccountJsonPlainText' or 'serviceAccountJson' to use this action"
      );
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

      expect(fs.writeFileSync).toHaveBeenCalledWith('/releases/signingKey.jks', 'a2V5', 'base64');
      expect(signApkFile).toHaveBeenCalledWith(
        '/releases/app.apk',
        '/releases/signingKey.jks',
        'alias',
        'store-pass',
        'key-pass'
      );
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
      expect(core.setFailed).toHaveBeenCalledWith('No valid release file to sign.');
      expect(core.exportVariable).toHaveBeenCalledWith('SIGNED_RELEASE_FILE_2', '');
      expect(core.setOutput).toHaveBeenCalledWith('signedReleaseFile2', '');
      expect(core.exportVariable).toHaveBeenCalledWith('NOF_SIGNED_RELEASE_FILES', '3');
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

      expect(core.setFailed).toHaveBeenCalledWith('Unknown error occurred.');
    });
  });

  describe('__testables.getReleaseNotes', () => {
    test('returns inline content directly', async () => {
      await expect(__testables.getReleaseNotes('none', undefined, 'inline')).resolves.toBe('inline');
    });

    test('reads release notes from file', async () => {
      ((fs.promises.readFile as unknown) as jest.Mock).mockResolvedValue('file-based');
      await expect(__testables.getReleaseNotes('file', './notes.md', undefined)).resolves.toBe('file-based');
    });

    test('handles file read failure', async () => {
      ((fs.promises.readFile as unknown) as jest.Mock).mockRejectedValue(new Error('no file'));
      await expect(__testables.getReleaseNotes('file', './missing.md', undefined)).resolves.toBeUndefined();
      expect(core.setFailed).toHaveBeenCalledWith('Failed to read release notes file: ./missing.md');
    });

    test('handles file read failure with non-Error value', async () => {
      ((fs.promises.readFile as unknown) as jest.Mock).mockRejectedValue('missing');
      await expect(__testables.getReleaseNotes('file', './missing.md', undefined)).resolves.toBeUndefined();
      expect(logger.e).toHaveBeenCalledWith('Failed to read release notes file: ./missing.md. Error: missing');
    });

    test('generates notes from git commits and logs stderr', async () => {
      (exec as jest.Mock).mockImplementation(async (_cmd: string, _args: string[], options: { listeners: { stdout: (data: Buffer) => void; stderr: (data: Buffer) => void } }) => {
        options.listeners.stdout(Buffer.from('feat: a\nfix: b'));
        options.listeners.stderr(Buffer.from('warning'));
      });

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBe('feat: a\nfix: b');
      expect(logger.w).toHaveBeenCalledWith('Git command stderr: warning');
    });

    test('generates notes from git commits without stderr', async () => {
      (exec as jest.Mock).mockImplementation(async (_cmd: string, _args: string[], options: { listeners: { stdout: (data: Buffer) => void; stderr: (data: Buffer) => void } }) => {
        options.listeners.stdout(Buffer.from('feat: clean output'));
      });

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBe('feat: clean output');
    });

    test('handles git command failure', async () => {
      (exec as jest.Mock).mockRejectedValue(new Error('git unavailable'));

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBeUndefined();
      expect(core.setFailed).toHaveBeenCalledWith('Failed to generate release notes from git commits.');
    });

    test('handles git command failure with non-Error value', async () => {
      (exec as jest.Mock).mockRejectedValue('git failed');

      await expect(__testables.getReleaseNotes('git-commits', undefined, undefined)).resolves.toBeUndefined();
      expect(logger.e).toHaveBeenCalledWith('Failed to get git commits: git failed');
    });

    test('returns undefined for unsupported source', async () => {
      await expect(__testables.getReleaseNotes('none', undefined, undefined)).resolves.toBeUndefined();
    });
  });
});
