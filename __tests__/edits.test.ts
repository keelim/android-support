const mockAndroidPublisher = {
  edits: {
    delete: jest.fn(),
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
  accessSync: jest.fn(),
  constants: { R_OK: 4 },
  createReadStream: jest.fn(() => 'stream'),
  realpathSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
  lstatSync: jest.fn(),
}));

import * as core from '@actions/core';
import * as fs from 'fs';
import { readLocalizedReleaseNotes } from '../src/whatsnew';
import { __testables, EditOptions, runUpload } from '../src/edits';

type TrackUpdateRequest = {
  requestBody: {
    releases: Array<{
      inAppUpdatePriority?: number;
      releaseNotes?: Array<{ language?: string | null; text?: string | null }>;
      userFraction?: number;
      versionCodes?: string[];
    }>;
  };
};

type TrackUpdateMock = jest.Mock<unknown, [TrackUpdateRequest]>;

function lastTrackUpdateRequest(): TrackUpdateRequest {
  const call = (mockAndroidPublisher.edits.tracks.update as TrackUpdateMock).mock.calls.at(-1);
  if (!call) {
    throw new Error('tracks.update was not called');
  }
  return call[0];
}

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
    mockAndroidPublisher.edits.tracks.update.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      data: { track: 'production', releases: [{ versionCodes: ['101', '102', '201', '202'] }] },
    });
    mockAndroidPublisher.edits.commit.mockResolvedValue({ data: { id: 'edit-1' }, status: 200, statusText: 'OK' });
    mockAndroidPublisher.edits.insert.mockResolvedValue({ data: { id: 'new-edit' } });
    mockAndroidPublisher.edits.delete.mockResolvedValue({});
    mockAndroidPublisher.edits.deobfuscationfiles.upload.mockResolvedValue({});
    (readLocalizedReleaseNotes as jest.Mock).mockResolvedValue([{ language: 'en-US', text: 'notes' }]);
    (fs.accessSync as jest.Mock).mockReturnValue(undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file'));
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((filePath: string) => filePath);
    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
    (fs.lstatSync as jest.Mock).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 1024,
    });
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

    expect(core.setOutput).toHaveBeenCalledWith('internalSharingDownloadUrls', '["https://download/apk","https://download/aab"]');
    expect(core.exportVariable).toHaveBeenCalledWith('INTERNAL_SHARING_DOWNLOAD_URLS', '["https://download/apk","https://download/aab"]');
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

    expect(lastTrackUpdateRequest().requestBody.releases).toMatchObject([{ inAppUpdatePriority: 0 }]);
  });

  describe('__testables.uploadToPlayStore', () => {
    test('rejects when commit response has no edit id', async () => {
      mockAndroidPublisher.edits.commit.mockResolvedValueOnce({ data: {}, status: 500, statusText: 'FAIL' });

      await expect(__testables.uploadToPlayStore(options(), ['app.aab'])).rejects.toThrow(
        'Commit response missing edit id (packageName=com.example.app, editId=new-edit, track=production, status=500, statusText=FAIL)'
      );
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(mockAndroidPublisher.edits.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          editId: 'new-edit',
          packageName: 'com.example.app',
        })
      );
    });

    test('logs cleanup failure when deleting a new edit fails', async () => {
      mockAndroidPublisher.edits.commit.mockResolvedValueOnce({ data: {}, status: 500, statusText: 'FAIL' });
      mockAndroidPublisher.edits.delete.mockRejectedValue(new Error('delete unavailable'));

      await expect(__testables.uploadToPlayStore(options(), ['app.aab'])).rejects.toThrow('Commit response missing edit id');
      expect(mockAndroidPublisher.edits.delete).toHaveBeenCalled();
    });

    test('does not delete caller-owned existing edit on failure', async () => {
      mockAndroidPublisher.edits.tracks.list.mockResolvedValueOnce({ status: 404, statusText: 'Not Found', data: {} });

      await expect(__testables.uploadToPlayStore(options({ existingEditId: 'caller-edit' }), ['app.aab'])).rejects.toThrow(
        'Failed to list tracks'
      );
      expect(mockAndroidPublisher.edits.delete).not.toHaveBeenCalled();
    });

    test('rejects empty release file arrays before Play API calls', async () => {
      await expect(__testables.uploadToPlayStore(options(), [])).rejects.toThrow('At least one release file is required for upload.');
      expect(mockAndroidPublisher.edits.insert).not.toHaveBeenCalled();
    });

    test('wraps rejected commit promises and cleans up new edits', async () => {
      mockAndroidPublisher.edits.commit.mockRejectedValue(new Error('commit network failed'));

      await expect(__testables.uploadToPlayStore(options(), ['app.aab'])).rejects.toThrow('edits.commit failed');
      expect(mockAndroidPublisher.edits.delete).toHaveBeenCalledWith(expect.objectContaining({ editId: 'new-edit' }));
    });

    test('wraps rejected tracks.update promises and skips commit', async () => {
      mockAndroidPublisher.edits.tracks.update.mockRejectedValue(new Error('track update failed'));

      await expect(__testables.uploadToPlayStore(options(), ['app.aab'])).rejects.toThrow('tracks.update failed');
      expect(mockAndroidPublisher.edits.commit).not.toHaveBeenCalled();
      expect(mockAndroidPublisher.edits.delete).toHaveBeenCalled();
    });
  });

  describe('__testables.uploadInternalSharingRelease', () => {
    test('uploads apk and returns download url', async () => {
      await expect(__testables.uploadInternalSharingRelease(options(), 'app.apk')).resolves.toBe('https://download/apk');
      expect(core.setOutput).not.toHaveBeenCalledWith('internalSharingDownloadUrl', 'https://download/apk');
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
      await expect(__testables.validateSelectedTrack('edit-1', options())).rejects.toThrow(
        'Failed to list tracks (packageName=com.example.app, editId=edit-1, requestedTrack=production, status=404, statusText=Not Found)'
      );
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

      expect(result).toEqual({ track: 'production', releases: [{ versionCodes: ['101', '102', '201', '202'] }] });
      expect(readLocalizedReleaseNotes).not.toHaveBeenCalled();
      expect(lastTrackUpdateRequest().requestBody.releases).toMatchObject([
        {
          userFraction: 0.5,
          releaseNotes: explicitNotes,
          versionCodes: ['101', '102'],
        },
      ]);
    });

    test('loads localized release notes when explicit notes are missing', async () => {
      await __testables.addReleasesToTrack(
        'edit-1',
        options({ whatsNewDir: './notes', releaseNotes: undefined, userFraction: undefined }),
        [201]
      );

      expect(readLocalizedReleaseNotes).toHaveBeenCalledWith('./notes');
    });

    test('removes every zero version code before converting to strings', async () => {
      await __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [0, 101, 0, 102, 0]);

      expect(lastTrackUpdateRequest().requestBody.releases).toMatchObject([{ versionCodes: ['101', '102'] }]);
    });

    test('rejects when tracks.update response omits requested version codes', async () => {
      mockAndroidPublisher.edits.tracks.update.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { track: 'production', releases: [{ versionCodes: ['101'] }] },
      });

      await expect(
        __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [101, 202])
      ).rejects.toThrow('tracks.update response mismatch');
    });

    test('rejects when tracks.update response omits release versionCodes', async () => {
      mockAndroidPublisher.edits.tracks.update.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { track: 'production', releases: [{}] },
      });

      await expect(
        __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [101])
      ).rejects.toThrow('tracks.update response mismatch');
    });

    test('rejects when tracks.update response omits releases', async () => {
      mockAndroidPublisher.edits.tracks.update.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { track: 'production' },
      });

      await expect(
        __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [101])
      ).rejects.toThrow('tracks.update response mismatch');
    });

    test('rejects when there are no valid version codes', async () => {
      await expect(
        __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [0])
      ).rejects.toThrow('No valid versionCodes to release for edit edit-1 on track production');
    });

    test('rejects when tracks.update returns a non-success status', async () => {
      mockAndroidPublisher.edits.tracks.update.mockResolvedValueOnce({
        status: 500,
        statusText: 'Server Error',
        data: { track: 'production', releases: [{ versionCodes: ['101'] }] },
      });

      await expect(
        __testables.addReleasesToTrack('edit-1', options({ releaseNotes: [{ language: 'en-US', text: 'notes' }] }), [101])
      ).rejects.toThrow('tracks.update failed');
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

    test('propagates mapping file read failures and skips upload', async () => {
      (fs.readFileSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('mapping unreadable');
      });

      await expect(__testables.uploadMappingFile('edit-1', 101, options({ mappingFile: './mapping.txt' }))).rejects.toThrow(
        'mapping unreadable'
      );
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });
  });

  describe('__testables.uploadDebugSymbolsFile', () => {
    test('does nothing when debug symbols path is absent', async () => {
      await __testables.uploadDebugSymbolsFile('edit-1', 101, options({ debugSymbols: undefined }));
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });

    test('uploads zipped directory symbols', async () => {
      (fs.lstatSync as jest.Mock).mockImplementation((filePath: string) => ({
        isDirectory: () => filePath === '/tmp/symbols',
        isFile: () => filePath !== '/tmp/symbols',
        isSymbolicLink: () => false,
        size: 6,
      }));
      (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === '/tmp/symbols') return ['a.so'];
        return [];
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('binary'));

      await __testables.uploadDebugSymbolsFile('edit-1', 101, options({ debugSymbols: '/tmp/symbols' }));

      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          apkVersionCode: 101,
          deobfuscationFileType: 'nativeCode',
        })
      );
    });

    test('uploads file symbols directly', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1024,
      });
      (fs.readFileSync as jest.Mock).mockReturnValueOnce(Buffer.from('sym'));

      await __testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/tmp/symbols.zip' }));

      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          apkVersionCode: 102,
          deobfuscationFileType: 'nativeCode',
        })
      );
    });

    test('propagates debug symbols lstat failures', async () => {
      (fs.lstatSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('lstat failed');
      });

      await expect(__testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/tmp/symbols.zip' }))).rejects.toThrow(
        'lstat failed'
      );
      expect(mockAndroidPublisher.edits.deobfuscationfiles.upload).not.toHaveBeenCalled();
    });

    test('rejects symlink debug symbols input', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
        size: 0,
      });

      await expect(__testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/tmp/symbols.zip' }))).rejects.toThrow(
        'debugSymbols must not be a symbolic link: symbols.zip'
      );
    });

    test('rejects debug symbols paths that are neither file nor directory', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
        size: 0,
      });

      await expect(__testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/tmp/device' }))).rejects.toThrow(
        'debugSymbols must be a regular .zip file or directory: device'
      );
    });

    test('propagates debug symbols upload failures', async () => {
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1024,
      });
      (fs.readFileSync as jest.Mock).mockReturnValueOnce(Buffer.from('sym'));
      mockAndroidPublisher.edits.deobfuscationfiles.upload.mockRejectedValue(new Error('symbols upload failed'));

      await expect(__testables.uploadDebugSymbolsFile('edit-1', 102, options({ debugSymbols: '/tmp/symbols.zip' }))).rejects.toThrow(
        'deobfuscationfiles.upload.debugSymbols failed'
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
      (fs.lstatSync as jest.Mock).mockImplementation((filePath: string) => ({
        isDirectory: () => filePath.endsWith('/dir'),
        isFile: () => !filePath.endsWith('/dir'),
        isSymbolicLink: () => false,
        size: 8,
      }));
      (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => Buffer.from(`data:${filePath}`));

      const root = { file: jest.fn() };
      await __testables.zipFileAddDirectory(root as never, '/root', '/root', true);

      expect(root.file).toHaveBeenCalledWith('dir/file2.txt', expect.any(Buffer));
      expect(root.file).toHaveBeenCalledWith('file1.txt', expect.any(Buffer));
    });

    test('rejects symlinks while creating debug symbol zips', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['linked.so']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
        size: 0,
      });

      await expect(__testables.zipFileAddDirectory({ file: jest.fn() } as never, '/root', '/root', true)).rejects.toThrow(
        'debugSymbols must not contain symbolic links: linked.so'
      );
    });

    test('rejects debug symbol directory trees that are too deep', async () => {
      await expect(
        __testables.zipFileAddDirectory({ file: jest.fn() } as never, '/root', '/root', true, undefined, 17)
      ).rejects.toThrow('debugSymbols directory exceeds maximum depth 16');
    });

    test('rejects individual debug symbol files that are too large', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['huge.so']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 512 * 1024 * 1024 + 1,
      });

      await expect(__testables.zipFileAddDirectory({ file: jest.fn() } as never, '/root', '/root', true)).rejects.toThrow(
        'debugSymbols file is too large: huge.so'
      );
    });

    test('treats missing debug symbol file size as zero', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['unknown-size.so']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('binary'));

      const root = { file: jest.fn() };
      await __testables.zipFileAddDirectory(root as never, '/root', '/root', true);

      expect(root.file).toHaveBeenCalledWith('unknown-size.so', expect.any(Buffer));
    });

    test('rejects debug symbol directories with too many files', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['extra.so']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1,
      });

      await expect(
        __testables.zipFileAddDirectory({ file: jest.fn() } as never, '/root', '/root', true, {
          fileCount: 10000,
          rootRealPath: '/root',
          totalBytes: 0,
        })
      ).rejects.toThrow('debugSymbols directory contains more than 10000 files');
    });

    test('rejects debug symbol directories that exceed total size limits', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['extra.so']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 2,
      });

      await expect(
        __testables.zipFileAddDirectory({ file: jest.fn() } as never, '/root', '/root', true, {
          fileCount: 0,
          rootRealPath: '/root',
          totalBytes: 1024 * 1024 * 1024 - 1,
        })
      ).rejects.toThrow('debugSymbols directory exceeds 1073741824 bytes before compression');
    });

    test('supports null root without throwing', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['file1.txt']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 9,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file-data'));

      await expect(__testables.zipFileAddDirectory(null, '/root', '/root', false)).resolves.toBeUndefined();
    });

    test('creates a zip buffer from symbols directory', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['file1.txt']);
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 9,
      });
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

    test('wraps rejected apk upload promises', async () => {
      mockAndroidPublisher.edits.apks.upload.mockRejectedValue(new Error('apk upload failed'));

      await expect(__testables.uploadApk('edit-1', options(), 'app.apk')).rejects.toThrow('apks.upload failed');
    });

    test('wraps rejected bundle upload promises', async () => {
      mockAndroidPublisher.edits.bundles.upload.mockRejectedValue(new Error('bundle upload failed'));

      await expect(__testables.uploadBundle('edit-1', options(), 'app.aab')).rejects.toThrow('bundles.upload failed');
    });

    test('wraps unreadable apk paths', async () => {
      (fs.accessSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('no access');
      });

      await expect(__testables.uploadApk('edit-1', options(), 'missing.apk')).rejects.toThrow(
        'Unable to read APK release artifact file missing.apk: no access'
      );
    });

    test('wraps unreadable internal sharing bundle paths', async () => {
      (fs.accessSync as jest.Mock).mockImplementationOnce(() => {
        throw 'no access';
      });

      await expect(__testables.internalSharingUploadBundle(options(), 'missing.aab')).rejects.toThrow(
        'Unable to read internal sharing bundle file missing.aab: no access'
      );
    });

    test('wraps google api failures with context', async () => {
      await expect(__testables.withGoogleApiGuard('custom.operation', {}, async () => Promise.reject('bad'))).rejects.toThrow(
        'custom.operation failed: bad'
      );
    });

    test('classifies retryable google api errors', () => {
      expect(__testables.isRetryableError(null)).toBe(true);
      expect(__testables.isRetryableError({ status: 500 })).toBe(true);
      expect(__testables.isRetryableError({ code: 408 })).toBe(true);
      expect(__testables.isRetryableError({ response: { status: 429 } })).toBe(true);
      expect(__testables.isRetryableError({ status: 400 })).toBe(false);
    });

    test('times out stalled google api calls', async () => {
      jest.useFakeTimers();
      try {
        const guarded = expect(
          __testables.withGoogleApiGuard('slow.operation', {}, async () => new Promise(() => undefined))
        ).rejects.toThrow('slow.operation failed: slow.operation timed out after 600000ms');

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

        await guarded;
      } finally {
        jest.useRealTimers();
      }
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
      (fs.lstatSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1024,
      });

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
      await expect(__testables.uploadReleaseFiles('edit-1', options(), ['one.apk'])).rejects.toThrow(
        'APK upload for one.apk in edit edit-1 did not return a positive integer versionCode'
      );
    });

    test('defaults bundle version code to zero when bundle upload has no version', async () => {
      mockAndroidPublisher.edits.bundles.upload.mockResolvedValueOnce({ data: {} });
      await expect(__testables.uploadReleaseFiles('edit-1', options(), ['one.aab'])).rejects.toThrow(
        'AAB upload for one.aab in edit edit-1 did not return a positive integer versionCode'
      );
    });

    test('summarizes uploaded version codes when later file upload fails', async () => {
      mockAndroidPublisher.edits.bundles.upload.mockRejectedValue(new Error('network down'));

      await expect(__testables.uploadReleaseFiles('edit-1', options(), ['one.apk', 'two.aab'])).rejects.toThrow(
        'uploadedVersionCodes=101'
      );
    });

    test('throws for invalid release extension', async () => {
      await expect(__testables.uploadReleaseFiles('edit-1', options(), ['bad.txt'])).rejects.toThrow(
        'bad.txt is invalid (missing or invalid file extension).'
      );
    });

    test('preflights mapping and debug symbols before creating an edit', async () => {
      (fs.accessSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('symbols.zip')) throw new Error('missing symbols');
      });

      await expect(
        __testables.uploadToPlayStore(options({ mappingFile: './mapping.txt', debugSymbols: './symbols.zip' }), ['one.apk'])
      ).rejects.toThrow('Unable to read debugSymbols file symbols.zip: missing symbols');
      expect(mockAndroidPublisher.edits.insert).not.toHaveBeenCalled();
    });
  });

  test('__testables.inferInternalSharingDownloadUrl builds expected url', () => {
    expect(__testables.inferInternalSharingDownloadUrl('com.example.app', 123)).toBe(
      'https://play.google.com/apps/test/com.example.app/123'
    );
  });
});
