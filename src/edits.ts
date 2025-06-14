/**
 * Google Play Console 편집 관련 유틸리티
 * 앱 업로드, 트랙 관리, 릴리스 관리 등의 기능 제공
 */
import * as core from '@actions/core';
import * as fs from 'fs';
import { lstatSync, readFileSync } from 'fs';
import JSZip from 'jszip';
import { Readable } from 'stream';

import * as google from '@googleapis/androidpublisher';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { GoogleAuth } from 'google-auth-library/build/src/auth/googleauth';
import { readLocalizedReleaseNotes } from './whatsnew';
import * as logger from './utils/logger';
import path = require('path');

import AndroidPublisher = androidpublisher_v3.Androidpublisher;
import Apk = androidpublisher_v3.Schema$Apk;
import Bundle = androidpublisher_v3.Schema$Bundle;
import Track = androidpublisher_v3.Schema$Track;
import InternalAppSharingArtifact = androidpublisher_v3.Schema$InternalAppSharingArtifact;
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

const androidPublisher: AndroidPublisher = google.androidpublisher('v3');

/**
 * 편집 옵션 인터페이스
 * Google Play Console 편집에 필요한 모든 옵션 정의
 */
export interface EditOptions {
  auth: GoogleAuth; // Google 인증 객체
  applicationId: string; // 앱 패키지 ID
  track: string; // 릴리스 트랙
  inAppUpdatePriority: number; // 인앱 업데이트 우선순위
  userFraction?: number; // 점진적 출시 비율
  whatsNewDir?: string; // 릴리스 노트 디렉토리
  mappingFile?: string; // ProGuard 매핑 파일
  debugSymbols?: string; // 디버그 심볼 파일
  name?: string; // 릴리스 이름
  status: string; // 릴리스 상태
  changesNotSentForReview?: boolean; // 리뷰 없이 변경사항 적용 여부
  existingEditId?: string; // 기존 편집 ID
  releaseNotes?: LocalizedText[]; // 릴리스 노트
}

/**
 * 앱 업로드 실행 함수
 * Google Play Console에 앱을 업로드하고 릴리스 정보를 설정
 */
export async function runUpload(
  packageName: string,
  track: string,
  inAppUpdatePriority: number | undefined,
  userFraction: number | undefined,
  whatsNewDir: string | undefined,
  mappingFile: string | undefined,
  debugSymbols: string | undefined,
  name: string | undefined,
  changesNotSentForReview: boolean,
  existingEditId: string | undefined,
  status: string,
  validatedReleaseFiles: string[],
  releaseNotes: LocalizedText[] | undefined
) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  const result = await uploadToPlayStore(
    {
      auth: auth,
      applicationId: packageName,
      track: track,
      inAppUpdatePriority: inAppUpdatePriority || 0,
      userFraction: userFraction,
      whatsNewDir: whatsNewDir,
      mappingFile: mappingFile,
      debugSymbols: debugSymbols,
      name: name,
      changesNotSentForReview: changesNotSentForReview,
      existingEditId: existingEditId,
      status: status,
      releaseNotes: releaseNotes,
    },
    validatedReleaseFiles
  );

  if (result) {
    console.log(`Finished uploading to the Play Store: ${result}`);
  }
}

/**
 * Google Play Store 업로드 함수
 * 내부 공유 또는 일반 트랙에 따라 적절한 업로드 방식 선택
 */
async function uploadToPlayStore(options: EditOptions, releaseFiles: string[]): Promise<string | void> {
  const internalSharingDownloadUrls: string[] = [];

  // 내부 공유 트랙인 경우 특별한 업로드 API 사용
  if (options.track === 'internalsharing') {
    logger.d('Track is Internal app sharing, switch to special upload api');
    for (const releaseFile of releaseFiles) {
      logger.d(`Uploading ${releaseFile}`);
      const url = await uploadInternalSharingRelease(options, releaseFile);
      internalSharingDownloadUrls.push(url);
    }
  } else {
    // 새 편집 생성
    const appEditId = await getOrCreateEdit(options);

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

    const res = await androidPublisher.edits.commit({
      auth: options.auth,
      editId: appEditId,
      packageName: options.applicationId,
      changesNotSentForReview: options.changesNotSentForReview,
    });

    // 커밋 성공 여부 확인
    if (res.data.id) {
      logger.i(`Successfully committed ${res.data.id}`);
      return res.data.id;
    } else {
      core.setFailed(`Error ${res.status}: ${res.statusText}`);
      return Promise.reject(res.status);
    }
  }

  core.setOutput('internalSharingDownloadUrls', internalSharingDownloadUrls);
  core.exportVariable('INTERNAL_SHARING_DOWNLOAD_URLS', internalSharingDownloadUrls);
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
  core.setOutput('internalSharingDownloadUrl', res.downloadUrl);
  core.exportVariable('INTERNAL_SHARING_DOWNLOAD_URL', res.downloadUrl);
  console.log(`${releaseFile} uploaded to Internal Sharing, download it with ${res.downloadUrl}`);

  return res.downloadUrl;
}

/**
 * 선택된 트랙 검증
 * 지정된 트랙이 유효한지 확인
 */
async function validateSelectedTrack(appEditId: string, options: EditOptions): Promise<void> {
  logger.i(`Validating track '${options.track}'`);
  const res = await androidPublisher.edits.tracks.list({
    auth: options.auth,
    editId: appEditId,
    packageName: options.applicationId,
  });

  // 200 상태 코드가 아닌 경우 오류 전파
  if (res.status != 200) {
    throw Error(res.statusText);
  }

  const allTracks = res.data.tracks;
  // 트랙이 있는지 확인
  if (!allTracks) {
    throw Error('No tracks found, unable to validate track.');
  }

  // 트랙이 유효한지 확인
  if (allTracks.find(value => value.track == options.track) == undefined) {
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

  const res = await androidPublisher.edits.tracks.update({
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
          releaseNotes: options.releaseNotes ?? (await readLocalizedReleaseNotes(options.whatsNewDir)),
          versionCodes: versionCodes.filter(x => x != 0).map(x => x.toString()),
        },
      ],
    },
  });

  return res.data;
}

/**
 * 매핑 파일 업로드
 * ProGuard 매핑 파일을 Google Play Console에 업로드
 */
async function uploadMappingFile(appEditId: string, versionCode: number, options: EditOptions) {
  if (options.mappingFile != undefined && options.mappingFile.length > 0) {
    const mapping = readFileSync(options.mappingFile, 'utf-8');
    if (mapping != undefined) {
      logger.d(
        `[${appEditId}, versionCode=${versionCode}, packageName=${options.applicationId}]: Uploading Proguard mapping file @ ${options.mappingFile}`
      );
      await androidPublisher.edits.deobfuscationfiles.upload({
        auth: options.auth,
        packageName: options.applicationId,
        editId: appEditId,
        apkVersionCode: versionCode,
        deobfuscationFileType: 'proguard',
        media: {
          mimeType: 'application/octet-stream',
          body: fs.createReadStream(options.mappingFile),
        },
      });
    }
  }
}

/**
 * 디버그 심볼 파일 업로드
 * 디버그 심볼 파일을 Google Play Console에 업로드
 */
async function uploadDebugSymbolsFile(appEditId: string, versionCode: number, options: EditOptions) {
  if (options.debugSymbols != undefined && options.debugSymbols.length > 0) {
    const fileStat = lstatSync(options.debugSymbols);

    let data: Buffer | null = null;
    if (fileStat.isDirectory()) {
      data = await createDebugSymbolZipFile(options.debugSymbols);
    }

    if (data == null) {
      data = readFileSync(options.debugSymbols);
    }

    if (data != null) {
      logger.d(
        `[${appEditId}, versionCode=${versionCode}, packageName=${options.applicationId}]: Uploading Debug Symbols file @ ${options.debugSymbols}`
      );
      await androidPublisher.edits.deobfuscationfiles.upload({
        auth: options.auth,
        packageName: options.applicationId,
        editId: appEditId,
        apkVersionCode: versionCode,
        deobfuscationFileType: 'nativeCode',
        media: {
          mimeType: 'application/octet-stream',
          body: Readable.from(data),
        },
      });
    }
  }
}

/**
 * 디렉토리를 ZIP 파일에 추가
 * 디버그 심볼 디렉토리를 ZIP 파일로 압축
 */
async function zipFileAddDirectory(root: JSZip | null, dirPath: string, rootPath: string, isRootRoot: boolean) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      await zipFileAddDirectory(root, filePath, rootPath, false);
    } else {
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
  const res = await androidPublisher.internalappsharingartifacts.uploadapk({
    auth: options.auth,
    packageName: options.applicationId,
    media: {
      mimeType: 'application/vnd.android.package-archive',
      body: fs.createReadStream(apkReleaseFile),
    },
  });
  return res.data;
}

/**
 * 내부 공유 AAB 업로드
 * AAB 파일을 내부 공유용으로 업로드
 */
async function internalSharingUploadBundle(options: EditOptions, bundleReleaseFile: string): Promise<InternalAppSharingArtifact> {
  const res = await androidPublisher.internalappsharingartifacts.uploadbundle({
    auth: options.auth,
    packageName: options.applicationId,
    media: {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(bundleReleaseFile),
    },
  });
  return res.data;
}

/**
 * APK 업로드
 * APK 파일을 Google Play Console에 업로드
 */
async function uploadApk(appEditId: string, options: EditOptions, apkReleaseFile: string): Promise<Apk> {
  const res = await androidPublisher.edits.apks.upload({
    auth: options.auth,
    packageName: options.applicationId,
    editId: appEditId,
    media: {
      mimeType: 'application/vnd.android.package-archive',
      body: fs.createReadStream(apkReleaseFile),
    },
  });
  return res.data;
}

/**
 * AAB 업로드
 * AAB 파일을 Google Play Console에 업로드
 */
async function uploadBundle(appEditId: string, options: EditOptions, bundleReleaseFile: string): Promise<Bundle> {
  const res = await androidPublisher.edits.bundles.upload({
    auth: options.auth,
    packageName: options.applicationId,
    editId: appEditId,
    media: {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(bundleReleaseFile),
    },
  });
  return res.data;
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
  const res = await androidPublisher.edits.insert({
    auth: options.auth,
    packageName: options.applicationId,
  });

  if (res.data.id) {
    logger.d(`Created edit with id: ${res.data.id}`);
    return res.data.id;
  } else {
    throw Error('Failed to create an edit');
  }
}

/**
 * 릴리스 파일 업로드
 * APK/AAB 파일을 Google Play Console에 업로드
 */
async function uploadReleaseFiles(appEditId: string, options: EditOptions, releaseFiles: string[]): Promise<number[]> {
  const versionCodes: number[] = [];

  for (const releaseFile of releaseFiles) {
    logger.d(`Uploading ${releaseFile}`);
    let versionCode = 0;

    if (releaseFile.endsWith('.apk')) {
      const apk = await uploadApk(appEditId, options, releaseFile);
      versionCode = apk.versionCode || 0;
      await uploadMappingFile(appEditId, versionCode, options);
      await uploadDebugSymbolsFile(appEditId, versionCode, options);
    } else if (releaseFile.endsWith('.aab')) {
      const bundle = await uploadBundle(appEditId, options, releaseFile);
      versionCode = bundle.versionCode || 0;
    } else {
      throw Error(`${releaseFile} is invalid (missing or invalid file extension).`);
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
