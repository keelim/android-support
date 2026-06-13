/**
 * Google Play Console 편집 관련 유틸리티
 * 앱 업로드, 트랙 관리, 릴리스 관리 등의 기능 제공
 */
import * as core from '@actions/core';
import * as fs from 'fs';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { Readable } from 'stream';

import * as google from '@googleapis/androidpublisher';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { GoogleAuth } from 'google-auth-library/build/src/auth/googleauth';
import { readLocalizedReleaseNotes } from './whatsnew';
import * as logger from './utils/logger';
import path = require('path');
import { without } from 'es-toolkit/array';
import {
  assertPathInsideAllowedRoots,
  assertPathInsideRoot,
  normalizeUnknownError,
  resolveSecureDirectory,
  resolveSecureFile,
  safeBasenameForLog,
} from './utils/security-utils';
import { ReleaseStatus } from './input-validation';

import AndroidPublisher = androidpublisher_v3.Androidpublisher;
import Apk = androidpublisher_v3.Schema$Apk;
import Bundle = androidpublisher_v3.Schema$Bundle;
import Track = androidpublisher_v3.Schema$Track;
import InternalAppSharingArtifact = androidpublisher_v3.Schema$InternalAppSharingArtifact;
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

type LiteralUnion<T extends U, U = string> = T | (U & Record<never, never>);

export type ReleaseTrack = LiteralUnion<'internalsharing' | 'production' | 'beta' | 'alpha' | 'internal', string>;

export interface RunUploadOptions {
  packageName: string;
  track: ReleaseTrack;
  inAppUpdatePriority: number | undefined;
  userFraction: number | undefined;
  whatsNewDir: string | undefined;
  mappingFile: string | undefined;
  debugSymbols: string | undefined;
  name: string | undefined;
  changesNotSentForReview: boolean;
  existingEditId: string | undefined;
  status: ReleaseStatus;
  releaseFiles: string[];
  releaseNotes: LocalizedText[] | undefined;
}

type UploadToPlayStoreResult =
  | {
      kind: 'edit';
      editId: string;
    }
  | {
      kind: 'internalsharing';
      downloadUrls: string[];
    };

interface GoogleApiResponse<T> {
  status?: number;
  statusText?: string;
  data?: T;
}

const androidPublisher: AndroidPublisher = google.androidpublisher('v3');
const GOOGLE_API_TIMEOUT_MS = 10 * 60 * 1000;
const GOOGLE_API_RETRY_ATTEMPTS = 3;
const MAX_MAPPING_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DEBUG_SYMBOL_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_DEBUG_SYMBOL_FILE_BYTES = 512 * 1024 * 1024;
const MAX_DEBUG_SYMBOL_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_DEBUG_SYMBOL_FILES = 10000;
const MAX_DEBUG_SYMBOL_DEPTH = 16;

function normalizeError(error: unknown): Error {
  return normalizeUnknownError(error);
}

function formatResponseContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

function assertSuccessfulResponseStatus<T>(operation: string, context: Record<string, unknown>, res: GoogleApiResponse<T>): void {
  if (res.status === undefined || (res.status >= 200 && res.status < 300)) {
    return;
  }

  const details = [formatResponseContext(context), `status=${res.status}`, `statusText=${res.statusText}`].filter(Boolean).join(', ');
  throw new Error(`${operation} failed (${details})`);
}

function requireResponseData<T>(operation: string, context: Record<string, unknown>, res: GoogleApiResponse<T>): T {
  assertSuccessfulResponseStatus(operation, context, res);
  if (res.data !== undefined && res.data !== null) {
    return res.data;
  }

  throw new Error(`${operation} response missing data (${formatResponseContext(context)})`);
}

function isRetryableError(error: unknown): boolean {
  const maybeStatus = (error as { code?: number; status?: number; response?: { status?: number } }) ?? {};
  const status = maybeStatus.status ?? maybeStatus.code ?? maybeStatus.response?.status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

async function withGoogleApiGuard<T>(operation: string, context: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= GOOGLE_API_RETRY_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(fn(), operation);
    } catch (error: unknown) {
      lastError = error;
      if (attempt === GOOGLE_API_RETRY_ATTEMPTS || !isRetryableError(error)) break;
      logger.w(`${operation} failed on attempt ${attempt}/${GOOGLE_API_RETRY_ATTEMPTS}: ${normalizeError(error).message}; retrying`);
    }
  }

  const contextText = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  throw new Error(`${operation} failed${contextText ? ` (${contextText})` : ''}: ${normalizeError(lastError).message}`);
}

async function withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${operation} timed out after ${GOOGLE_API_TIMEOUT_MS}ms`)), GOOGLE_API_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertPositiveVersionCode(versionCode: unknown, artifactType: string, releaseFile: string, appEditId: string): number {
  if (typeof versionCode === 'number' && Number.isInteger(versionCode) && versionCode > 0) {
    return versionCode;
  }

  throw new Error(
    `${artifactType} upload for ${releaseFile} in edit ${appEditId} did not return a positive integer versionCode; received ${String(versionCode)}`
  );
}

/**
 * 편집 옵션 인터페이스
 * Google Play Console 편집에 필요한 모든 옵션 정의
 */
export interface EditOptions {
  auth: GoogleAuth; // Google 인증 객체
  applicationId: string; // 앱 패키지 ID
  track: ReleaseTrack; // 릴리스 트랙
  inAppUpdatePriority: number; // 인앱 업데이트 우선순위
  userFraction?: number; // 점진적 출시 비율
  whatsNewDir?: string; // 릴리스 노트 디렉토리
  mappingFile?: string; // ProGuard 매핑 파일
  debugSymbols?: string; // 디버그 심볼 파일
  name?: string; // 릴리스 이름
  status: ReleaseStatus; // 릴리스 상태
  changesNotSentForReview?: boolean; // 리뷰 없이 변경사항 적용 여부
  existingEditId?: string; // 기존 편집 ID
  releaseNotes?: LocalizedText[]; // 릴리스 노트
}

/**
 * 앱 업로드 실행 함수
 * Google Play Console에 앱을 업로드하고 릴리스 정보를 설정
 */
export async function runUpload(options: RunUploadOptions): Promise<void> {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  const result = await uploadToPlayStore(
    {
      auth: auth,
      applicationId: options.packageName,
      track: options.track,
      inAppUpdatePriority: options.inAppUpdatePriority ?? 0,
      userFraction: options.userFraction,
      whatsNewDir: options.whatsNewDir,
      mappingFile: options.mappingFile,
      debugSymbols: options.debugSymbols,
      name: options.name,
      changesNotSentForReview: options.changesNotSentForReview,
      existingEditId: options.existingEditId,
      status: options.status,
      releaseNotes: options.releaseNotes,
    },
    options.releaseFiles
  );

  if (result.kind === 'edit') {
    console.log(`Finished uploading to the Play Store: ${result.editId}`);
  }
}

/**
 * Google Play Store 업로드 함수
 * 내부 공유 또는 일반 트랙에 따라 적절한 업로드 방식 선택
 */
async function uploadToPlayStore(options: EditOptions, releaseFiles: string[]): Promise<UploadToPlayStoreResult> {
  if (releaseFiles.length === 0) {
    throw new Error('At least one release file is required for upload.');
  }

  const internalSharingDownloadUrls: string[] = [];

  // 내부 공유 트랙인 경우 특별한 업로드 API 사용
  if (options.track === 'internalsharing') {
    logger.d('Track is Internal app sharing, switch to special upload api');
    let lastDownloadUrl = '';
    for (const releaseFile of releaseFiles) {
      logger.d(`Uploading ${releaseFile}`);
      const url = await uploadInternalSharingRelease(options, releaseFile);
      lastDownloadUrl = url;
      internalSharingDownloadUrls.push(url);
    }

    core.setOutput('internalSharingDownloadUrl', lastDownloadUrl);
    core.exportVariable('INTERNAL_SHARING_DOWNLOAD_URL', lastDownloadUrl);
  } else {
    preflightReleaseArtifacts(options, releaseFiles);

    // 새 편집 생성
    const appEditId = await getOrCreateEdit(options);
    const ownsEdit = !options.existingEditId;

    try {
      // 선택된 트랙 검증
      await validateSelectedTrack(appEditId, options);

      // Google Play에 아티팩트 업로드 및 버전 코드 저장
      const versionCodes = await uploadReleaseFiles(appEditId, options, releaseFiles);

      // 버전 코드로부터 다운로드 URL 추론
      for (const versionCode of versionCodes) {
        const url = inferInternalSharingDownloadUrl(options.applicationId, versionCode);
        core.setOutput('internalSharingDownloadUrl', url);
        core.exportVariable('INTERNAL_SHARING_DOWNLOAD_URL', url);
        internalSharingDownloadUrls.push(url);
      }

      // 업로드된 아티팩트를 트랙에 추가
      await addReleasesToTrack(appEditId, options, versionCodes);

      // 대기 중인 편집 커밋
      logger.i(`Committing the Edit`);

      const res = await withGoogleApiGuard(
        'edits.commit',
        { packageName: options.applicationId, editId: appEditId, track: options.track },
        () =>
          androidPublisher.edits.commit({
            auth: options.auth,
            editId: appEditId,
            packageName: options.applicationId,
            changesNotSentForReview: options.changesNotSentForReview,
          })
      );
      const data = requireResponseData('edits.commit', { packageName: options.applicationId, editId: appEditId, track: options.track }, res);

      // 커밋 성공 여부 확인
      if (data.id) {
        logger.i(`Successfully committed ${data.id}`);
        return { kind: 'edit', editId: data.id };
      }

      throw new Error(
        `Commit response missing edit id (packageName=${options.applicationId}, editId=${appEditId}, track=${options.track}, status=${res.status}, statusText=${res.statusText})`
      );
    } catch (error: unknown) {
      if (ownsEdit) {
        await cleanupEdit(appEditId, options, error);
      } else {
        logger.w(
          `Upload failed while using existing edit ${appEditId}; this action will not delete caller-owned edits. Review the edit in Google Play Console before retrying.`
        );
      }
      throw error;
    }
  }

  const serializedDownloadUrls = JSON.stringify(internalSharingDownloadUrls);
  core.setOutput('internalSharingDownloadUrls', serializedDownloadUrls);
  core.exportVariable('INTERNAL_SHARING_DOWNLOAD_URLS', serializedDownloadUrls);
  return { kind: 'internalsharing', downloadUrls: internalSharingDownloadUrls };
}

/**
 * 내부 공유 릴리스 업로드
 * APK 또는 AAB 파일을 내부 공유용으로 업로드
 */
async function uploadInternalSharingRelease(options: EditOptions, releaseFile: string): Promise<string> {
  let res: google.androidpublisher_v3.Schema$InternalAppSharingArtifact;
  if (releaseFile.endsWith('.apk')) {
    res = await internalSharingUploadApk(options, releaseFile);
  } else if (releaseFile.endsWith('.aab')) {
    res = await internalSharingUploadBundle(options, releaseFile);
  } else {
    throw Error(`${releaseFile} is invalid (missing or invalid file extension).`);
  }

  if (!res.downloadUrl) throw Error('Uploaded file has no download URL.');
  console.log(`${releaseFile} uploaded to Internal Sharing, download it with ${res.downloadUrl}`);

  return res.downloadUrl;
}

async function cleanupEdit(appEditId: string, options: EditOptions, originalError: unknown): Promise<void> {
  logger.w(
    `Upload failed before commit for new edit ${appEditId}; attempting to delete the edit. Cause: ${normalizeError(originalError).message}`
  );
  try {
    await withGoogleApiGuard('edits.delete', { packageName: options.applicationId, editId: appEditId }, () =>
      androidPublisher.edits.delete({
        auth: options.auth,
        editId: appEditId,
        packageName: options.applicationId,
      })
    );
    logger.i(`Deleted uncommitted edit ${appEditId}`);
  } catch (cleanupError: unknown) {
    logger.w(`Failed to delete uncommitted edit ${appEditId}: ${normalizeError(cleanupError).message}`);
  }
}

/**
 * 선택된 트랙 검증
 * 지정된 트랙이 유효한지 확인
 */
async function validateSelectedTrack(appEditId: string, options: EditOptions): Promise<void> {
  logger.i(`Validating track '${options.track}'`);
  const res = await withGoogleApiGuard('tracks.list', { packageName: options.applicationId, editId: appEditId, track: options.track }, () =>
    androidPublisher.edits.tracks.list({
      auth: options.auth,
      editId: appEditId,
      packageName: options.applicationId,
    })
  );

  // 200 상태 코드가 아닌 경우 오류 전파
  if (res.status !== 200) {
    throw Error(
      `Failed to list tracks (packageName=${options.applicationId}, editId=${appEditId}, requestedTrack=${options.track}, status=${res.status}, statusText=${res.statusText})`
    );
  }

  const data = requireResponseData('tracks.list', { packageName: options.applicationId, editId: appEditId, track: options.track }, res);
  const allTracks = data.tracks;
  // 트랙이 있는지 확인
  if (!allTracks) {
    throw Error('No tracks found, unable to validate track.');
  }

  // 트랙이 유효한지 확인
  if (allTracks.find(value => value.track === options.track) === undefined) {
    const allTrackNames = allTracks.map(track => {
      return track.track;
    });
    throw Error(`Track "${options.track}" could not be found. Available tracks are: ${allTrackNames.toString()}`);
  }
}

/**
 * 트랙에 릴리스 추가
 * 업로드된 아티팩트를 지정된 트랙에 추가
 */
async function addReleasesToTrack(appEditId: string, options: EditOptions, versionCodes: number[]): Promise<Track> {
  const status = options.status;

  logger.d(`Creating release for:`);
  logger.d(`edit=${appEditId}`);
  logger.d(`track=${options.track}`);
  if (options.userFraction) {
    logger.d(`userFraction=${options.userFraction}`);
  }
  logger.d(`status=${status}`);
  logger.d(`versionCodes=${versionCodes.toString()}`);

  const requestedVersionCodes = without(versionCodes, 0).map(x => x.toString());
  if (requestedVersionCodes.length === 0) {
    throw new Error(`No valid versionCodes to release for edit ${appEditId} on track ${options.track}`);
  }
  const releaseNotes = options.releaseNotes ?? (await readLocalizedReleaseNotes(options.whatsNewDir));

  const res = await withGoogleApiGuard('tracks.update', { packageName: options.applicationId, editId: appEditId, track: options.track }, () =>
    androidPublisher.edits.tracks.update({
      auth: options.auth,
      editId: appEditId,
      packageName: options.applicationId,
      track: options.track,
      requestBody: {
        track: options.track,
        releases: [
          {
            name: options.name,
            userFraction: options.userFraction,
            status: status,
            inAppUpdatePriority: options.inAppUpdatePriority,
            releaseNotes,
            versionCodes: requestedVersionCodes,
          },
        ],
      },
    })
  );
  const responseData = requireResponseData('tracks.update', { packageName: options.applicationId, editId: appEditId, track: options.track }, res);

  const returnedTrack = responseData.track;
  const returnedVersionCodes = responseData.releases?.flatMap(release => release.versionCodes ?? []) ?? [];
  const missingVersionCodes = requestedVersionCodes.filter(versionCode => !returnedVersionCodes.includes(versionCode));
  if (returnedTrack !== options.track || returnedVersionCodes.length === 0 || missingVersionCodes.length > 0) {
    throw new Error(
      `tracks.update response mismatch (packageName=${options.applicationId}, editId=${appEditId}, requestedTrack=${options.track}, returnedTrack=${returnedTrack}, missingVersionCodes=${missingVersionCodes.join(',')})`
    );
  }

  return responseData;
}

function preflightReleaseArtifacts(options: EditOptions, releaseFiles: string[]) {
  for (const releaseFile of releaseFiles) {
    resolveReleaseArtifactFile(releaseFile, 'release artifact');
  }
  if (options.mappingFile) {
    resolveMappingFilePath(options.mappingFile);
  }
  if (options.debugSymbols) {
    resolveDebugSymbolsPath(options.debugSymbols);
  }
}

function resolveReleaseArtifactFile(filePath: string, label: string): string {
  return resolveSecureFile(filePath, label, {
    extensions: ['.apk', '.aab'],
  });
}

function resolveMappingFilePath(mappingFile: string): string {
  return resolveSecureFile(mappingFile, 'mappingFile', {
    extensions: ['.txt', '.map'],
    maxBytes: MAX_MAPPING_FILE_BYTES,
  });
}

function resolveDebugSymbolsPath(debugSymbols: string): { kind: 'directory' | 'file'; path: string } {
  const absolutePath = path.resolve(debugSymbols);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (error: unknown) {
    throw new Error(`Unable to inspect debugSymbols ${safeBasenameForLog(debugSymbols)}: ${normalizeError(error).message}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`debugSymbols must not be a symbolic link: ${safeBasenameForLog(debugSymbols)}`);
  }

  const realPath = fs.realpathSync(absolutePath);
  assertPathInsideAllowedRoots(realPath, 'debugSymbols');

  if (stats.isDirectory()) {
    return { kind: 'directory', path: resolveSecureDirectory(debugSymbols, 'debugSymbols') };
  }

  if (stats.isFile()) {
    return {
      kind: 'file',
      path: resolveSecureFile(debugSymbols, 'debugSymbols', {
        extensions: ['.zip'],
        maxBytes: MAX_DEBUG_SYMBOL_ZIP_BYTES,
      }),
    };
  }

  throw new Error(`debugSymbols must be a regular .zip file or directory: ${safeBasenameForLog(debugSymbols)}`);
}

/**
 * 매핑 파일 업로드
 * ProGuard 매핑 파일을 Google Play Console에 업로드
 */
async function uploadMappingFile(appEditId: string, versionCode: number, options: EditOptions) {
  if (options.mappingFile != undefined && options.mappingFile.length > 0) {
    const mappingFile = resolveMappingFilePath(options.mappingFile);
    const mapping = readFileSync(mappingFile, 'utf-8');
    if (mapping != undefined) {
      logger.d(
        `[${appEditId}, versionCode=${versionCode}, packageName=${options.applicationId}]: Uploading Proguard mapping file @ ${safeBasenameForLog(mappingFile)}`
      );
      const res = await withGoogleApiGuard(
        'deobfuscationfiles.upload.mapping',
        { packageName: options.applicationId, editId: appEditId, versionCode, mappingFile },
        () =>
          androidPublisher.edits.deobfuscationfiles.upload({
            auth: options.auth,
            packageName: options.applicationId,
            editId: appEditId,
            apkVersionCode: versionCode,
            deobfuscationFileType: 'proguard',
            media: {
              mimeType: 'application/octet-stream',
              body: fs.createReadStream(mappingFile),
            },
          })
      );
      assertSuccessfulResponseStatus('deobfuscationfiles.upload.mapping', {
        packageName: options.applicationId,
        editId: appEditId,
        versionCode,
        mappingFile,
      }, res);
    }
  }
}

/**
 * 디버그 심볼 파일 업로드
 * 디버그 심볼 파일을 Google Play Console에 업로드
 */
async function uploadDebugSymbolsFile(appEditId: string, versionCode: number, options: EditOptions) {
  if (options.debugSymbols != undefined && options.debugSymbols.length > 0) {
    const debugSymbols = resolveDebugSymbolsPath(options.debugSymbols);

    let data: Buffer | null = null;
    if (debugSymbols.kind === 'directory') {
      data = await createDebugSymbolZipFile(debugSymbols.path);
    }

    if (data == null) {
      data = readFileSync(debugSymbols.path);
    }

    if (data != null) {
      logger.d(
        `[${appEditId}, versionCode=${versionCode}, packageName=${options.applicationId}]: Uploading Debug Symbols file @ ${safeBasenameForLog(debugSymbols.path)}`
      );
      const res = await withGoogleApiGuard(
        'deobfuscationfiles.upload.debugSymbols',
        { packageName: options.applicationId, editId: appEditId, versionCode, debugSymbols: safeBasenameForLog(debugSymbols.path) },
        () =>
          androidPublisher.edits.deobfuscationfiles.upload({
            auth: options.auth,
            packageName: options.applicationId,
            editId: appEditId,
            apkVersionCode: versionCode,
            deobfuscationFileType: 'nativeCode',
            media: {
              mimeType: 'application/octet-stream',
              body: Readable.from(data),
            },
          })
      );
      assertSuccessfulResponseStatus('deobfuscationfiles.upload.debugSymbols', {
        packageName: options.applicationId,
        editId: appEditId,
        versionCode,
        debugSymbols: safeBasenameForLog(debugSymbols.path),
      }, res);
    }
  }
}

/**
 * 디렉토리를 ZIP 파일에 추가
 * 디버그 심볼 디렉토리를 ZIP 파일로 압축
 */
interface ZipTraversalState {
  fileCount: number;
  rootRealPath: string;
  totalBytes: number;
}

async function zipFileAddDirectory(
  root: JSZip | null,
  dirPath: string,
  rootPath: string,
  isRootRoot: boolean,
  state?: ZipTraversalState,
  depth = 0
) {
  const traversal = state ?? {
    fileCount: 0,
    rootRealPath: fs.realpathSync(rootPath),
    totalBytes: 0,
  };

  if (depth > MAX_DEBUG_SYMBOL_DEPTH) {
    throw new Error(`debugSymbols directory exceeds maximum depth ${MAX_DEBUG_SYMBOL_DEPTH}`);
  }

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`debugSymbols must not contain symbolic links: ${safeBasenameForLog(filePath)}`);
    }

    const realPath = fs.realpathSync(filePath);
    assertPathInsideRoot(realPath, traversal.rootRealPath, 'debugSymbols archive entry');

    if (stat.isDirectory()) {
      await zipFileAddDirectory(root, filePath, rootPath, false, traversal, depth + 1);
    } else if (stat.isFile()) {
      const fileSize = typeof stat.size === 'number' ? stat.size : 0;
      if (fileSize > MAX_DEBUG_SYMBOL_FILE_BYTES) {
        throw new Error(`debugSymbols file is too large: ${safeBasenameForLog(filePath)}`);
      }
      traversal.fileCount += 1;
      traversal.totalBytes += fileSize;
      if (traversal.fileCount > MAX_DEBUG_SYMBOL_FILES) {
        throw new Error(`debugSymbols directory contains more than ${MAX_DEBUG_SYMBOL_FILES} files`);
      }
      if (traversal.totalBytes > MAX_DEBUG_SYMBOL_TOTAL_BYTES) {
        throw new Error(`debugSymbols directory exceeds ${MAX_DEBUG_SYMBOL_TOTAL_BYTES} bytes before compression`);
      }
      const relativePath = path.relative(rootPath, filePath);
      root?.file(relativePath, fs.readFileSync(filePath));
    }
  }
}

/**
 * 디버그 심볼 ZIP 파일 생성
 * 디버그 심볼 디렉토리를 ZIP 파일로 압축
 */
async function createDebugSymbolZipFile(debugSymbolsPath: string) {
  const zip = new JSZip();
  await zipFileAddDirectory(zip, debugSymbolsPath, debugSymbolsPath, true);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * 내부 공유 APK 업로드
 * APK 파일을 내부 공유용으로 업로드
 */
async function internalSharingUploadApk(options: EditOptions, apkReleaseFile: string): Promise<InternalAppSharingArtifact> {
  const releaseFile = resolveReleaseArtifactFile(apkReleaseFile, 'internal sharing APK');
  const res = await withGoogleApiGuard('internalappsharingartifacts.uploadapk', { packageName: options.applicationId, releaseFile: apkReleaseFile }, () =>
    androidPublisher.internalappsharingartifacts.uploadapk({
      auth: options.auth,
      packageName: options.applicationId,
      media: {
        mimeType: 'application/vnd.android.package-archive',
        body: fs.createReadStream(releaseFile),
      },
    })
  );
  return requireResponseData('internalappsharingartifacts.uploadapk', { packageName: options.applicationId, releaseFile: apkReleaseFile }, res);
}

/**
 * 내부 공유 AAB 업로드
 * AAB 파일을 내부 공유용으로 업로드
 */
async function internalSharingUploadBundle(options: EditOptions, bundleReleaseFile: string): Promise<InternalAppSharingArtifact> {
  const releaseFile = resolveReleaseArtifactFile(bundleReleaseFile, 'internal sharing bundle');
  const res = await withGoogleApiGuard(
    'internalappsharingartifacts.uploadbundle',
    { packageName: options.applicationId, releaseFile: bundleReleaseFile },
    () =>
      androidPublisher.internalappsharingartifacts.uploadbundle({
        auth: options.auth,
        packageName: options.applicationId,
        media: {
          mimeType: 'application/octet-stream',
          body: fs.createReadStream(releaseFile),
        },
      })
  );
  return requireResponseData('internalappsharingartifacts.uploadbundle', { packageName: options.applicationId, releaseFile: bundleReleaseFile }, res);
}

/**
 * APK 업로드
 * APK 파일을 Google Play Console에 업로드
 */
async function uploadApk(appEditId: string, options: EditOptions, apkReleaseFile: string): Promise<Apk> {
  const releaseFile = resolveReleaseArtifactFile(apkReleaseFile, 'APK release artifact');
  const res = await withGoogleApiGuard('apks.upload', { packageName: options.applicationId, editId: appEditId, releaseFile: apkReleaseFile }, () =>
    androidPublisher.edits.apks.upload({
      auth: options.auth,
      packageName: options.applicationId,
      editId: appEditId,
      media: {
        mimeType: 'application/vnd.android.package-archive',
        body: fs.createReadStream(releaseFile),
      },
    })
  );
  return requireResponseData('apks.upload', { packageName: options.applicationId, editId: appEditId, releaseFile: apkReleaseFile }, res);
}

/**
 * AAB 업로드
 * AAB 파일을 Google Play Console에 업로드
 */
async function uploadBundle(appEditId: string, options: EditOptions, bundleReleaseFile: string): Promise<Bundle> {
  const releaseFile = resolveReleaseArtifactFile(bundleReleaseFile, 'AAB release artifact');
  const res = await withGoogleApiGuard('bundles.upload', { packageName: options.applicationId, editId: appEditId, releaseFile: bundleReleaseFile }, () =>
    androidPublisher.edits.bundles.upload({
      auth: options.auth,
      packageName: options.applicationId,
      editId: appEditId,
      media: {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(releaseFile),
      },
    })
  );
  return requireResponseData('bundles.upload', { packageName: options.applicationId, editId: appEditId, releaseFile: bundleReleaseFile }, res);
}

/**
 * 편집 생성 또는 가져오기
 * 기존 편집 ID가 있으면 사용, 없으면 새로 생성
 */
async function getOrCreateEdit(options: EditOptions): Promise<string> {
  if (options.existingEditId) {
    logger.d(`Using existing edit: ${options.existingEditId}`);
    return options.existingEditId;
  }

  logger.d('Creating a new edit');
  const res = await withGoogleApiGuard('edits.insert', { packageName: options.applicationId }, () =>
    androidPublisher.edits.insert({
      auth: options.auth,
      packageName: options.applicationId,
    })
  );
  const data = requireResponseData('edits.insert', { packageName: options.applicationId }, res);

  if (data.id) {
    logger.d(`Created edit with id: ${data.id}`);
    return data.id;
  } else {
    throw Error(
      `Failed to create an edit (packageName=${options.applicationId}, status=${res.status}, statusText=${res.statusText})`
    );
  }
}

/**
 * 릴리스 파일 업로드
 * APK/AAB 파일을 Google Play Console에 업로드
 */
async function uploadReleaseFiles(appEditId: string, options: EditOptions, releaseFiles: string[]): Promise<number[]> {
  const versionCodes: number[] = [];
  const uploadedVersionCodes: number[] = [];

  for (const releaseFile of releaseFiles) {
    logger.d(`Uploading ${releaseFile}`);
    let versionCode: number;

    try {
      if (releaseFile.endsWith('.apk')) {
        const apk = await uploadApk(appEditId, options, releaseFile);
        versionCode = assertPositiveVersionCode(apk.versionCode, 'APK', releaseFile, appEditId);
        uploadedVersionCodes.push(versionCode);
        await uploadMappingFile(appEditId, versionCode, options);
        await uploadDebugSymbolsFile(appEditId, versionCode, options);
      } else if (releaseFile.endsWith('.aab')) {
        const bundle = await uploadBundle(appEditId, options, releaseFile);
        versionCode = assertPositiveVersionCode(bundle.versionCode, 'AAB', releaseFile, appEditId);
        uploadedVersionCodes.push(versionCode);
      } else {
        throw Error(`${releaseFile} is invalid (missing or invalid file extension).`);
      }
    } catch (error: unknown) {
      throw new Error(
        `Failed while uploading ${releaseFile} to edit ${appEditId}; uploadedVersionCodes=${uploadedVersionCodes.join(',') || 'none'}: ${
          normalizeError(error).message
        }`
      );
    }

    versionCodes.push(versionCode);
  }

  return versionCodes;
}

/**
 * 내부 공유 다운로드 URL 추론
 * 앱 ID와 버전 코드로부터 내부 공유 다운로드 URL 생성
 */
function inferInternalSharingDownloadUrl(applicationId: string, versionCode: number) {
  return `https://play.google.com/apps/test/${applicationId}/${versionCode}`;
}

export const __testables = {
  uploadToPlayStore,
  uploadInternalSharingRelease,
  validateSelectedTrack,
  addReleasesToTrack,
  uploadMappingFile,
  uploadDebugSymbolsFile,
  zipFileAddDirectory,
  createDebugSymbolZipFile,
  internalSharingUploadApk,
  internalSharingUploadBundle,
  uploadApk,
  uploadBundle,
  getOrCreateEdit,
  uploadReleaseFiles,
  withGoogleApiGuard,
  cleanupEdit,
  isRetryableError,
  inferInternalSharingDownloadUrl,
};
