const mockAndroidPublisher = {
  edits: {
    commit: jest.fn(),
    tracks: {
      list: jest.fn(),
      update: jest.fn(),
    },
    deobfuscationfiles: {
      upload: jest.fn(),
    },
    apks: {
      upload: jest.fn(),
    },
    bundles: {
      upload: jest.fn(),
    },
    insert: jest.fn(),
  },
  internalappsharingartifacts: {
    uploadapk: jest.fn(),
    uploadbundle: jest.fn(),
  },
};

const googleAuthCtor = jest.fn();

jest.mock('@googleapis/androidpublisher', () => ({
  __esModule: true,
  androidpublisher: jest.fn(() => mockAndroidPublisher),
  auth: {
    GoogleAuth: googleAuthCtor,
  },
}));

jest.mock('@actions/core', () => ({
  setOutput: jest.fn(),
  exportVariable: jest.fn(),
  setFailed: jest.fn(),
}));

jest.mock('../src/whatsnew', () => ({
  readLocalizedReleaseNotes: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  d: jest.fn(),
  i: jest.fn(),
  w: jest.fn(),
  e: jest.fn(),
}));

jest.mock('fs', () => ({
  __esModule: true,
  createReadStream: jest.fn(() => 'stream'),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
  lstatSync: jest.fn(),
}));

import * as core from '@actions/core';
import * as fs from 'fs';
import { readLocalizedReleaseNotes } from '../src/whatsnew';
import { __testables, EditOptions, runUpload } from '../src/edits';

function options(overrides: Partial<EditOptions> = {}): EditOptions {
  return {
    auth: { auth: true } as never,
    applicationId: 'com.example.app',
    track: 'production',
    inAppUpdatePriority: 3,
    status: 'completed',
    ...overrides,
  };
}

describe('edits module', () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    googleAuthCtor.mockImplementation(() => ({ googleAuth: true }));
    mockAndroidPublisher.internalappsharingartifacts.uploadapk.mockResolvedValue({ data: { downloadUrl: 'https://download/apk' } });
    mockAndroidPublisher.internalappsharingartifacts.uploadbundle.mockResolvedValue({ data: { downloadUrl: 'https://download/aab' } });
    mockAndroidPublisher.edits.tracks.list.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      data: { tracks: [{ track: 'production' }, { track: 'internal' }] },
    });
    mockAndroidPublisher.edits.apks.upload.mockResolvedValue({ data: { versionCode: 101 } });
    mockAndroidPublisher.edits.bundles.upload.mockResolvedValue({ data: { versionCode: 202 } });
    mockAndroidPublisher.edits.tracks.update.mockResolvedValue({ data: { track: 'production' } });
    mockAndroidPublisher.edits.commit.mockResolvedValue({ data: { id: 'edit-1' }, status: 200, statusText: 'OK' });
    mockAndroidPublisher.edits.insert.mockResolvedValue({ data: { id: 'new-edit' } });
    mockAndroidPublisher.edits.deobfuscationfiles.upload.mockResolvedValue({});
    (readLocalizedReleaseNotes as jest.Mock).mockResolvedValue([{ language: 'en-US', text: 'notes' }]);
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file'));
    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
    (fs.lstatSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  test('runUpload logs completed edit id when commit succeeds', async () => {
    await runUpload(
      'com.example.app',
      'production',
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      'completed',
      ['app.aab'],
      undefined
    );

    expect(googleAuthCtor).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    expect(logSpy).toHaveBeenCalledWith('Finished uploading to the Play Store: edit-1');
  });

  test('runUpload handles internalsharing track without final edit id log', async () => {
    await runUpload(
      'com.example.app',
      'internalsharing',
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      'completed',
      ['artifact.apk', 'artifact.aab'],
      undefined
    );

    expect(core.setOutput).toHaveBeenCalledWith('internalSharingDownloadUrls', ['https://download/apk', 'https://download/aab']);
    expect(core.exportVariable).toHaveBeenCalledWith('INTERNAL_SHARING_DOWNLOAD_URLS', ['https://download/apk', 'https://download/aab']);
  });

  test('runUpload defaults inAppUpdatePriority to zero when undefined', async () => {
    await runUpload(
      'com.example.app',
      'production',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      'completed',
      ['app.aab'],
      undefined
    );

    expect(mockAndroidPublisher.edits.tracks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          releases: [expect.objectContaining({ inAppUpdatePriority: 0 })],
        }),
      })
    );
  });

  describe('__testables.uploadToPlayStore', () => {
    test('rejects when commit response has no edit id', async () => {
      mockAndroidPublisher.edits.commit.mockResolvedValueOnce({ data: {}, status: 500, statusText: 'FAIL' });

      await expect(__testables.uploadToPlayStore(options(), ['app.aab'])).rejects.toBe(500);
      expect(core.setFailed).toHaveBeenCalledWith('Error 500: FAIL');
    });
  });

  describe('__testables.uploadInternalSharingRelease', () => {
    test('uploads apk and returns download url', async () => {
      await expect(__testables.uploadInternalSharingRelease(options(), 'app.apk')).resolves.toBe('https://download/apk');
      expect(core.setOutput).toHaveBeenCalledWith('internalSharingDownloadUrl', 'https://download/apk');
    });

    test('uploads aab and returns download url', async () => {
      await expect(__testables.uploadInternalSharingRelease(options(), 'app.aab')).resolves.toBe('https://download/aab');
    });

    test('fails for invalid extension', async () => {
      await expect(__testables.uploadInternalSharingRelease(options(), 'app.txt')).rejects.toThrow(
        'app.txt is invalid (missing or invalid file extension).'
      );
    });

    test('fails when uploaded artifact has no download url', async () => {
      mockAndroidPublisher.internalappsharingartifacts.uploadapk.mockResolvedValueOnce({ data: {} });
      await expect(__testables.uploadInternalSharingRelease(options(), 'app.apk')).rejects.toThrow('Uploaded file has no download URL.');
    });
  });

  describe('__testables.validateSelectedTrack', () => {
    test('throws on non-200 response', async () => {
      mockAndroidPublisher.edits.tracks.list.mockResolvedValueOnce({ status: 404, statusText: 'Not Found', data: {} });
      await expect(__testables.validateSelectedTrack('edit-1', options())).rejects.toThrow('Not Found');
    });

    test('throws when track list is missing', async () => {
      mockAndroidPublisher.edits.tracks.list.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: { tracks: undefined } });
      await expect(__testables.validateSelectedTrack('edit-1', options())).rejects.toThrow('No tracks found, unable to validate track.');
    });

    test('throws when selected track is absent', async () => {
      mockAndroidPublisher.edits.tracks.list.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { tracks: [{ track: 'internal' }] },
      });
      await expect(__testables.validateSelectedTrack('edit-1', options())).rejects.toThrow(
        'Track "production" could not be found. Available tracks are: internal'
      );
    });

    test('passes when selected track exists', async () => {
      await expect(__testables.validateSelectedTrack('edit-1', options())).resolves.toBeUndefined();
    });
  });

  describe('__testables.addReleasesToTrack', () => {
    test('uses explicit release notes and filtered version codes', async () => {
      const explicitNotes = [{ language: 'ko-KR', text: '직접 입력' }];
      const result = await __testables.addReleasesToTrack(
        'edit-1',
        options({ userFraction: 0.5, releaseNotes: explicitNotes }),
        [101, 0, 102]
      );

      expect(result).toEqual({ track: 'production' });
      expect(readLocalizedReleaseNotes).not.toHaveBeenCalled();
      expect(mockAndroidPublisher.edits.tracks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            releases: [
              expect.objectContaining({
                userFraction: 0.5,
                releaseNotes: explicitNotes,
                versionCodes: ['101', '102'],
              }),
            ],
          }),
        })
      );
    });

    test('loads localized release notes when explicit notes are missing', async () => {
      await __testables.addReleasesToTrack(
        'edit-1',
        options({ whatsNewDir: './notes', releaseNotes: undefined, userFraction: undefined }),
        [201]
      );

      expect(readLocalizedReleaseNotes).toHaveBeenCalledWith('./notes');
    });
  });

  describe('__testables.uploadMappingFile', () => {
    test('does nothing when mapping file path is absent', async () => {
      await __testables.uploadMappingFile('edit-1', 101, options({ mappingFile: undefined }));
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });

    test('does nothing when mapping content is undefined', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValueOnce(undefined);
      await __testables.uploadMappingFile('edit-1', 101, options({ mappingFile: './mapping.txt' }));
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });

    test('uploads mapping file when mapping content exists', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValueOnce('mapping');
      await __testables.uploadMappingFile('edit-1', 101, options({ mappingFile: './mapping.txt' }));
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          apkVersionCode: 101,
          deobfuscationFileType: 'proguard',
        })
      );
    });
  });

  describe('__testables.uploadDebugSymbolsFile', () => {
    test('does nothing when debug symbols path is absent', async () => {
      await __testables.uploadDebugSymbolsFile('edit-1', 101, options({ debugSymbols: undefined }));
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });

    test('uploads zipped directory symbols', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => true });
      (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === '/symbols') return ['a.so'];
        return [];
      });
      (fs.statSync as jest.Mock).mockImplementation((file: string) => ({
        isDirectory: () => false,
        file,
      }));
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('binary'));

      await __testables.uploadDebugSymbolsFile('edit-1', 101, options({ debugSymbols: '/symbols' }));

      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          apkVersionCode: 101,
          deobfuscationFileType: 'nativeCode',
        })
      );
    });

    test('uploads file symbols directly', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValueOnce({ isDirectory: () => false });
      (fs.readFileSync as jest.Mock).mockReturnValueOnce(Buffer.from('sym'));

      await __testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/symbols.zip' }));

      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          apkVersionCode: 102,
          deobfuscationFileType: 'nativeCode',
        })
      );
    });
  });

  describe('__testables.zipFileAddDirectory and createDebugSymbolZipFile', () => {
    test('adds files recursively with relative paths', async () => {
      (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === '/root') return ['dir', 'file1.txt'];
        if (dir === '/root/dir') return ['file2.txt'];
        return [];
      });
      (fs.statSync as jest.Mock).mockImplementation((filePath: string) => ({
        isDirectory: () => filePath.endsWith('/dir'),
      }));
      (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => Buffer.from(`data:${filePath}`));

      const root = { file: jest.fn() };
      await __testables.zipFileAddDirectory(root as never, '/root', '/root', true);

      expect(root.file).toHaveBeenCalledWith('dir/file2.txt', expect.any(Buffer));
      expect(root.file).toHaveBeenCalledWith('file1.txt', expect.any(Buffer));
    });

    test('supports null root without throwing', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['file1.txt']);
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file-data'));

      await expect(__testables.zipFileAddDirectory(null, '/root', '/root', false)).resolves.toBeUndefined();
    });

    test('creates a zip buffer from symbols directory', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['file1.txt']);
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file-data'));

      const buffer = await __testables.createDebugSymbolZipFile('/root');

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe('__testables.upload helpers', () => {
    test('uploads internal sharing apk', async () => {
      const res = await __testables.internalSharingUploadApk(options(), 'app.apk');
      expect(mockAndroidPublisher.internalappsharingartifacts.uploadapk).toHaveBeenCalled();
      expect(res).toEqual({ downloadUrl: 'https://download/apk' });
    });

    test('uploads internal sharing bundle', async () => {
      const res = await __testables.internalSharingUploadBundle(options(), 'app.aab');
      expect(mockAndroidPublisher.internalappsharingartifacts.uploadbundle).toHaveBeenCalled();
      expect(res).toEqual({ downloadUrl: 'https://download/aab' });
    });

    test('uploads apk', async () => {
      const res = await __testables.uploadApk('edit-1', options(), 'app.apk');
      expect(mockAndroidPublisher.edits.apks.upload).toHaveBeenCalled();
      expect(res).toEqual({ versionCode: 101 });
    });

    test('uploads bundle', async () => {
      const res = await __testables.uploadBundle('edit-1', options(), 'app.aab');
      expect(mockAndroidPublisher.edits.bundles.upload).toHaveBeenCalled();
      expect(res).toEqual({ versionCode: 202 });
    });
  });

  describe('__testables.getOrCreateEdit', () => {
    test('returns existing edit id when provided', async () => {
      await expect(__testables.getOrCreateEdit(options({ existingEditId: 'existing-edit' }))).resolves.toBe('existing-edit');
    });

    test('creates a new edit when existing id is absent', async () => {
      mockAndroidPublisher.edits.insert.mockResolvedValueOnce({ data: { id: 'new-edit-id' } });
      await expect(__testables.getOrCreateEdit(options())).resolves.toBe('new-edit-id');
    });

    test('throws when new edit id is missing', async () => {
      mockAndroidPublisher.edits.insert.mockResolvedValueOnce({ data: {} });
      await expect(__testables.getOrCreateEdit(options())).rejects.toThrow('Failed to create an edit');
    });
  });

  describe('__testables.uploadReleaseFiles', () => {
    test('uploads apk and aab and collects version codes', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('mapping-file');
      (fs.lstatSync as jest.Mock).mockReturnValue({ isDirectory: () => false });

      const releaseOptions = options({
        mappingFile: './mapping.txt',
        debugSymbols: './symbols.zip',
      });

      const result = await __testables.uploadReleaseFiles('edit-1', releaseOptions, ['one.apk', 'two.aab']);

      expect(result).toEqual([101, 202]);
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledTimes(2);
    });

    test('defaults version code to zero when apk upload has no version', async () => {
      mockAndroidPublisher.edits.apks.upload.mockResolvedValueOnce({ data: {} });
      const result = await __testables.uploadReleaseFiles('edit-1', options(), ['one.apk']);
      expect(result).toEqual([0]);
    });

    test('defaults bundle version code to zero when bundle upload has no version', async () => {
      mockAndroidPublisher.edits.bundles.upload.mockResolvedValueOnce({ data: {} });
      const result = await __testables.uploadReleaseFiles('edit-1', options(), ['one.aab']);
      expect(result).toEqual([0]);
    });

    test('throws for invalid release extension', async () => {
      await expect(__testables.uploadReleaseFiles('edit-1', options(), ['bad.txt'])).rejects.toThrow(
        'bad.txt is invalid (missing or invalid file extension).'
      );
    });
  });

  test('__testables.inferInternalSharingDownloadUrl builds expected url', () => {
    expect(__testables.inferInternalSharingDownloadUrl('com.example.app', 123)).toBe(
      'https://play.google.com/apps/test/com.example.app/123'
    );
  });
});
