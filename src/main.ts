/**
 * Google Play Console에 Android 앱을 업로드하는 GitHub Action
 * 주요 기능:
 * 1. APK/AAB 파일 업로드
 * 2. 앱 서명
 * 3. 릴리스 노트 관리
 * 4. 스테이징 트랙 관리
 */
import * as core from '@actions/core';
import * as fs from 'fs';
import { runUpload } from './edits';
import { validateInAppUpdatePriority, validateReleaseFiles, validateStatus, validateUserFraction } from './input-validation';
import { unlink, writeFile } from 'fs/promises';
import pTimeout from 'p-timeout';
import * as io from './utils/io-utils';
import path from 'path';
import { signAabFile, signApkFile } from './signing';
import * as logger from './utils/logger';
import { exec } from '@actions/exec';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

/**
 * 메인 실행 함수
 * type 파라미터에 따라 upload 또는 sign 작업을 수행
 */
export async function run() {
  try {
    const type = core.getInput('type', { required: true });
    if (type === 'upload') {
      await uploadRun();
    } else if (type === 'sign') {
      await signRun();
    } else {
      core.setFailed(`Unknown type: ${type}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred.');
    }
  } finally {
    if (core.getInput('serviceAccountJsonPlainText', { required: false })) {
      // 서비스 계정 JSON 파일 정리
      logger.d('Cleaning up service account json file');
      await unlink('./serviceAccountJson.json');
    }
  }
}

/**
 * 앱 업로드 실행 함수
 * Google Play Console에 앱을 업로드하고 릴리스 정보를 설정
 */
export async function uploadRun() {
  try {
    // 필수 및 선택적 입력값 가져오기
    const serviceAccountJson = core.getInput('serviceAccountJson', { required: false });
    const serviceAccountJsonRaw = core.getInput('serviceAccountJsonPlainText', { required: false });
    const packageName = core.getInput('packageName', { required: true });
    const releaseFile = core.getInput('releaseFile', { required: false });
    const releaseFiles = core
      .getInput('releaseFiles', { required: false })
      ?.split(',')
      ?.filter(x => x !== '');
    const releaseName = core.getInput('releaseName', { required: false });
    const track = core.getInput('track', { required: true });
    const inAppUpdatePriority = core.getInput('inAppUpdatePriority', { required: false });
    const userFraction = core.getInput('userFraction', { required: false });
    const status = core.getInput('status', { required: false });
    const whatsNewDir = core.getInput('whatsNewDirectory', { required: false });
    const mappingFile = core.getInput('mappingFile', { required: false });
    const debugSymbols = core.getInput('debugSymbols', { required: false });
    const changesNotSentForReview = core.getInput('changesNotSentForReview', { required: false }) == 'true';
    const existingEditId = core.getInput('existingEditId');
    const releaseNotesSource = core.getInput('releaseNotesSource', { required: false }) || 'none';
    const releaseNotesPath = core.getInput('releaseNotesPath', { required: false });
    const releaseNotesContent = core.getInput('releaseNotes', { required: false });

    logger.d('Starting app upload process with the following inputs:');
    logger.d(`  packageName: ${packageName}`);
    logger.d(`  track: ${track}`);
    logger.d(`  releaseFile: ${releaseFile}`);
    logger.d(`  releaseFiles: ${releaseFiles?.join(', ')}`);
    logger.d(`  releaseName: ${releaseName}`);
    logger.d(`  inAppUpdatePriority: ${inAppUpdatePriority}`);
    logger.d(`  userFraction: ${userFraction}`);
    logger.d(`  status: ${status}`);
    logger.d(`  whatsNewDirectory: ${whatsNewDir}`);
    logger.d(`  mappingFile: ${mappingFile}`);
    logger.d(`  debugSymbols: ${debugSymbols}`);
    logger.d(`  changesNotSentForReview: ${changesNotSentForReview}`);
    logger.d(`  existingEditId: ${existingEditId}`);
    logger.d(`  releaseNotesSource: ${releaseNotesSource}`);
    logger.d(`  releaseNotesPath: ${releaseNotesPath}`);
    logger.d(`  releaseNotesContent (present): ${!!releaseNotesContent}`);

    // 릴리스 노트 가져오기
    let releaseNotes: LocalizedText[] | undefined;
    logger.d('Attempting to fetch release notes.');
    const fetchedReleaseNotes = await getReleaseNotes(releaseNotesSource, releaseNotesPath, releaseNotesContent);
    if (fetchedReleaseNotes) {
      logger.d('Release notes fetched successfully.');
      // 단일 문자열 릴리스 노트를 LocalizedText[] 형식으로 변환 (기본 언어는 en-US)
      releaseNotes = [{ language: 'en-US', text: fetchedReleaseNotes }];
    }

    // 서비스 계정 JSON 검증
    logger.d('Validating service account JSON.');
    await validateServiceAccountJson(serviceAccountJsonRaw, serviceAccountJson);
    logger.d('Service account JSON validated.');

    // 사용자 분수 검증
    let userFractionFloat: number | undefined;
    if (userFraction) {
      userFractionFloat = parseFloat(userFraction);
    } else {
      userFractionFloat = undefined;
    }
    logger.d(`Validating user fraction: ${userFractionFloat}`);
    await validateUserFraction(userFractionFloat);
    logger.d('User fraction validated.');

    // 릴리스 상태 검증
    logger.d(`Validating status: ${status}`);
    await validateStatus(status, userFractionFloat != undefined && !isNaN(userFractionFloat));
    logger.d('Status validated.');

    // 인앱 업데이트 우선순위 검증 (0-5 사이의 숫자)
    let inAppUpdatePriorityInt: number | undefined;
    if (inAppUpdatePriority) {
      inAppUpdatePriorityInt = parseInt(inAppUpdatePriority);
    } else {
      inAppUpdatePriorityInt = undefined;
    }
    logger.d(`Validating in-app update priority: ${inAppUpdatePriorityInt}`);
    await validateInAppUpdatePriority(inAppUpdatePriorityInt);
    logger.d('In-app update priority validated.');

    // 릴리스 파일 검증 (하위 호환성 유지)
    if (releaseFile) {
      logger.w(`WARNING!! 'releaseFile' is deprecated and will be removed in a future release. Please migrate to 'releaseFiles'`);
    }
    logger.d(`Validating release files: ${releaseFiles ?? [releaseFile]}`);
    const validatedReleaseFiles: string[] = await validateReleaseFiles(releaseFiles ?? [releaseFile]);
    logger.d(`Release files validated: ${validatedReleaseFiles.join(', ')}`);

    // 추가 파일 존재 여부 확인
    logger.d('Checking for additional files (whatsNewDir, mappingFile, debugSymbols).');
    if (whatsNewDir != undefined && whatsNewDir.length > 0 && !fs.existsSync(whatsNewDir)) {
      logger.w(`Unable to find 'whatsnew' directory @ ${whatsNewDir}`);
    } else if (whatsNewDir) {
      logger.d(`'whatsnew' directory found @ ${whatsNewDir}`);
    }

    if (mappingFile != undefined && mappingFile.length > 0 && !fs.existsSync(mappingFile)) {
      logger.w(`Unable to find 'mappingFile' @ ${mappingFile}`);
    } else if (mappingFile) {
      logger.d(`'mappingFile' found @ ${mappingFile}`);
    }

    if (debugSymbols != undefined && debugSymbols.length > 0 && !fs.existsSync(debugSymbols)) {
      logger.w(`Unable to find 'debugSymbols' @ ${debugSymbols}`);
    } else if (debugSymbols) {
      logger.d(`'debugSymbols' found @ ${debugSymbols}`);
    }
    logger.d('Additional file checks complete.');

    // 업로드 실행 (3.6e+6ms = 1시간 타임아웃)
    logger.d('Initiating app upload.');
    await pTimeout(
      runUpload(
        packageName,
        track,
        inAppUpdatePriorityInt,
        userFractionFloat,
        whatsNewDir,
        mappingFile,
        debugSymbols,
        releaseName,
        changesNotSentForReview,
        existingEditId,
        status,
        validatedReleaseFiles,
        releaseNotes
      ),
      {
        milliseconds: 3.6e6,
      }
    );
    logger.d('App upload process completed successfully.');
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred.');
    }
  } finally {
    if (core.getInput('serviceAccountJsonPlainText', { required: false })) {
      // 서비스 계정 JSON 파일 정리
      logger.d('Cleaning up service account json file');
      await unlink('./serviceAccountJson.json');
    }
  }
}

/**
 * 서비스 계정 JSON 파일 검증 및 설정
 * @param serviceAccountJsonRaw - 서비스 계정 JSON 원본 텍스트
 * @param serviceAccountJson - 서비스 계정 JSON 파일 경로
 */
async function validateServiceAccountJson(
  serviceAccountJsonRaw: string | undefined,
  serviceAccountJson: string | undefined
): Promise<string | undefined> {
  if (serviceAccountJson && serviceAccountJsonRaw) {
    // 두 가지 방식이 모두 제공된 경우 경고
    logger.w("Both 'serviceAccountJsonPlainText' and 'serviceAccountJson' were provided! 'serviceAccountJson' will be ignored.");
  }

  if (serviceAccountJsonRaw) {
    // 원본 텍스트가 제공된 경우 파일로 저장
    const serviceAccountFile = './serviceAccountJson.json';
    await writeFile(serviceAccountFile, serviceAccountJsonRaw, {
      encoding: 'utf8',
    });
    core.exportVariable('GOOGLE_APPLICATION_CREDENTIALS', serviceAccountFile);
  } else if (serviceAccountJson) {
    // JSON 파일 경로가 제공된 경우 환경 변수 설정
    core.exportVariable('GOOGLE_APPLICATION_CREDENTIALS', serviceAccountJson);
  } else {
    // 둘 다 제공되지 않은 경우 오류
    return Promise.reject("You must provide one of 'serviceAccountJsonPlainText' or 'serviceAccountJson' to use this action");
  }
}

/**
 * 앱 서명 실행 함수
 * APK/AAB 파일에 서명을 추가
 */
async function signRun() {
  try {
    if (process.env.DEBUG_ACTION === 'true') {
      logger.d('DEBUG FLAG DETECTED, SHORTCUTTING ACTION.');
      return;
    }

    // 서명에 필요한 입력값 가져오기
    const releaseDir = core.getInput('releaseDirectory');
    const signingKeyBase64 = core.getInput('signingKeyBase64');
    const alias = core.getInput('alias');
    const keyStorePassword = core.getInput('keyStorePassword');
    const keyPassword = core.getInput('keyPassword');

    console.log(`Preparing to sign key @ ${releaseDir} with signing key`);

    // 1. 릴리스 파일 찾기
    const releaseFiles = io.findReleaseFiles(releaseDir);
    if (releaseFiles !== undefined && releaseFiles.length !== 0) {
      // 2. 서명 키 디코딩 및 저장
      const signingKey = path.join(releaseDir, 'signingKey.jks');
      fs.writeFileSync(signingKey, signingKeyBase64, 'base64');

      // 3. 각 릴리스 파일에 대해 zipalign 및 서명 수행
      const signedReleaseFiles: string[] = [];
      let index = 0;
      for (const releaseFile of releaseFiles) {
        logger.d(`Found release to sign: ${releaseFile.name}`);
        const releaseFilePath = path.join(releaseDir, releaseFile.name);
        let signedReleaseFile = '';
        if (releaseFile.name.endsWith('.apk')) {
          signedReleaseFile = await signApkFile(releaseFilePath, signingKey, alias, keyStorePassword, keyPassword);
        } else if (releaseFile.name.endsWith('.aab')) {
          signedReleaseFile = await signAabFile(releaseFilePath, signingKey, alias, keyStorePassword, keyPassword);
        } else {
          logger.e('No valid release file to sign, abort.');
          core.setFailed('No valid release file to sign.');
        }

        // 각 서명된 릴리스 파일을 별도의 변수와 출력으로 저장
        core.exportVariable(`SIGNED_RELEASE_FILE_${index}`, signedReleaseFile);
        core.setOutput(`signedReleaseFile${index}`, signedReleaseFile);
        signedReleaseFiles.push(signedReleaseFile);
        ++index;
      }

      // 모든 서명된 릴리스 파일을 병합된 변수와 출력으로 저장
      core.exportVariable(`SIGNED_RELEASE_FILES`, signedReleaseFiles.join(':'));
      core.setOutput('signedReleaseFiles', signedReleaseFiles.join(':'));
      core.exportVariable(`NOF_SIGNED_RELEASE_FILES`, `${signedReleaseFiles.length}`);
      core.setOutput(`nofSignedReleaseFiles`, `${signedReleaseFiles.length}`);

      // 단일 서명된 릴리스 파일인 경우 특정 변수와 출력으로 저장
      if (signedReleaseFiles.length == 1) {
        core.exportVariable(`SIGNED_RELEASE_FILE`, signedReleaseFiles[0]);
        core.setOutput('signedReleaseFile', signedReleaseFiles[0]);
      }
      console.log('Releases signed!');
    } else {
      logger.e('No release files (.apk or .aab) could be found. Abort.');
      core.setFailed('No release files (.apk or .aab) could be found.');
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred.');
    }
  }
}

async function getReleaseNotes(source: string, path: string | undefined, content: string | undefined): Promise<string | undefined> {
  if (content) {
    logger.d('Using release notes provided directly.');
    return content;
  } else if (source === 'file' && path) {
    logger.d(`Reading release notes from file: ${path}`);
    try {
      return await fs.promises.readFile(path, 'utf8');
    } catch (error) {
      logger.e(`Failed to read release notes file: ${path}. Error: ${error instanceof Error ? error.message : String(error)}`);
      core.setFailed(`Failed to read release notes file: ${path}`);
      return undefined;
    }
  } else if (source === 'git-commits') {
    logger.d('Generating release notes from Git commits.');
    let output = '';
    let error = '';
    try {
      // Get the last 10 commit messages for now. This can be made more sophisticated later.
      await exec('git', ['log', '-10', '--pretty=format:%s'], {
        listeners: {
          stdout: (data: Buffer) => {
            output += data.toString();
          },
          stderr: (data: Buffer) => {
            error += data.toString();
          },
        },
      });
      if (error) {
        logger.w(`Git command stderr: ${error}`);
      }
      return output.trim();
    } catch (err) {
      logger.e(`Failed to get git commits: ${err instanceof Error ? err.message : String(err)}`);
      core.setFailed(`Failed to generate release notes from git commits.`);
      return undefined;
    }
  } else {
    logger.d('No release notes source specified or invalid source.');
    return undefined;
  }
}

void run();
