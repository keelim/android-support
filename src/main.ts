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
import { toReleaseStatus, validateInAppUpdatePriority, validateReleaseFiles, validateStatus, validateUserFraction } from './input-validation';
import { unlink, writeFile } from 'fs/promises';
import pTimeout from 'p-timeout';
import * as io from './utils/io-utils';
import path from 'path';
import { signAabFile, signApkFile } from './signing';
import * as logger from './utils/logger';
import { exec } from '@actions/exec';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { compact } from 'es-toolkit/array';
import { isNotNil } from 'es-toolkit/predicate';
import { readLocalizedReleaseNotes } from './whatsnew';
import {
  createSecureTempDir,
  normalizeUnknownError,
  resolveSecureFile,
  safeBasenameForLog,
  validateServiceAccountJsonPayload,
} from './utils/security-utils';
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

const SERVICE_ACCOUNT_FILE_NAME = 'serviceAccountJson.json';
const SIGNING_KEY_FILE_NAME = 'signingKey.jks';
const SERVICE_ACCOUNT_JSON_MAX_BYTES = 64 * 1024;
const RELEASE_NOTES_MAX_BYTES = 128 * 1024;
const STRICT_NUMBER_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
let generatedServiceAccountFile: string | undefined;

function normalizeError(error: unknown): Error {
  return normalizeUnknownError(error);
}

function parseStrictNumberInput(value: string, inputName: string): number {
  if (!STRICT_NUMBER_PATTERN.test(value)) {
    throw new Error(`'${inputName}' must be a valid number. Got ${value}`);
  }
  return Number(value);
}

function parseStrictIntegerInput(value: string, inputName: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`'${inputName}' must be a valid integer. Got ${value}`);
  }
  return Number(value);
}

function requireInputValue(value: string, inputName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Missing required input '${inputName}'`);
  }
  return value;
}

function optionalInputValue(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function optionalCommaSeparatedInputValues(value: string): string[] | undefined {
  const values = compact(value.split(',').map(item => item.trim()));
  return values.length > 0 ? values : undefined;
}

async function cleanupServiceAccountJsonFile(filePath = generatedServiceAccountFile): Promise<void> {
  if (!filePath) {
    logger.d('No generated service account json file to clean up');
    return;
  }

  logger.d('Cleaning up service account json file');
  try {
    await unlink(filePath);
    if (filePath === generatedServiceAccountFile) {
      generatedServiceAccountFile = undefined;
    }
  } catch (error: unknown) {
    const normalized = normalizeError(error);
    if ((normalized as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.d(`Service account json file already removed: ${safeBasenameForLog(filePath)}`);
      if (filePath === generatedServiceAccountFile) {
        generatedServiceAccountFile = undefined;
      }
      return;
    }
    logger.w(`Failed to clean up service account json file ${safeBasenameForLog(filePath)}: ${normalized.message}`);
  }
}

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
    core.setFailed(normalizeError(error).message);
  }
}

/**
 * 앱 업로드 실행 함수
 * Google Play Console에 앱을 업로드하고 릴리스 정보를 설정
 */
export async function uploadRun() {
  try {
    // 필수 및 선택적 입력값 가져오기
    const serviceAccountJson = optionalInputValue(core.getInput('serviceAccountJson', { required: false }));
    const serviceAccountJsonRaw = optionalInputValue(core.getInput('serviceAccountJsonPlainText', { required: false }));
    const packageName = requireInputValue(core.getInput('packageName', { required: false }), 'packageName');
    const releaseFile = optionalInputValue(core.getInput('releaseFile', { required: false }));
    const releaseFilesInput = core.getInput('releaseFiles', { required: false });
    const releaseFiles = optionalCommaSeparatedInputValues(releaseFilesInput);
    const releaseName = optionalInputValue(core.getInput('releaseName', { required: false }));
    const track = requireInputValue(core.getInput('track', { required: false }), 'track');
    const inAppUpdatePriority = core.getInput('inAppUpdatePriority', { required: false });
    const userFraction = core.getInput('userFraction', { required: false });
    const status = core.getInput('status', { required: false });
    const whatsNewDir = optionalInputValue(core.getInput('whatsNewDirectory', { required: false }));
    const mappingFile = optionalInputValue(core.getInput('mappingFile', { required: false }));
    const debugSymbols = optionalInputValue(core.getInput('debugSymbols', { required: false }));
    const changesNotSentForReview = core.getBooleanInput('changesNotSentForReview', { required: false });
    const existingEditId = optionalInputValue(core.getInput('existingEditId'));
    const releaseNotesSource = core.getInput('releaseNotesSource', { required: false }) || 'none';
    const releaseNotesPath = optionalInputValue(core.getInput('releaseNotesPath', { required: false }));
    const releaseNotesContent = optionalInputValue(core.getInput('releaseNotes', { required: false }));
    const dryRun = core.getBooleanInput('dryRun', { required: false });

    logger.d('Starting app upload process with the following inputs:');
    logger.d(`  packageName: ${packageName}`);
    logger.d(`  track: ${track}`);
    logger.d(`  releaseFile: ${safeBasenameForLog(releaseFile)}`);
    logger.d(`  releaseFiles: ${releaseFiles?.map(safeBasenameForLog).join(', ')}`);
    logger.d(`  releaseName: ${releaseName}`);
    logger.d(`  inAppUpdatePriority: ${inAppUpdatePriority}`);
    logger.d(`  userFraction: ${userFraction}`);
    logger.d(`  status: ${status}`);
    logger.d(`  whatsNewDirectory: ${safeBasenameForLog(whatsNewDir)}`);
    logger.d(`  mappingFile: ${safeBasenameForLog(mappingFile)}`);
    logger.d(`  debugSymbols: ${safeBasenameForLog(debugSymbols)}`);
    logger.d(`  changesNotSentForReview: ${changesNotSentForReview}`);
    logger.d(`  existingEditId: ${existingEditId ? `${existingEditId.slice(0, 4)}...` : undefined}`);
    logger.d(`  releaseNotesSource: ${releaseNotesSource}`);
    logger.d(`  releaseNotesPath: ${safeBasenameForLog(releaseNotesPath)}`);
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
      userFractionFloat = parseStrictNumberInput(userFraction, 'userFraction');
    } else {
      userFractionFloat = undefined;
    }
    logger.d(`Validating user fraction: ${userFractionFloat}`);
    await validateUserFraction(userFractionFloat);
    logger.d('User fraction validated.');

    // 릴리스 상태 검증
    logger.d(`Validating status: ${status}`);
    const releaseStatus = toReleaseStatus(status);
    await validateStatus(releaseStatus, userFractionFloat !== undefined);
    logger.d('Status validated.');

    // 인앱 업데이트 우선순위 검증 (0-5 사이의 숫자)
    let inAppUpdatePriorityInt: number | undefined;
    if (inAppUpdatePriority) {
      inAppUpdatePriorityInt = parseStrictIntegerInput(inAppUpdatePriority, 'inAppUpdatePriority');
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
    const releaseFileCandidates = releaseFiles ?? (releaseFile ? [releaseFile] : undefined);
    logger.d(`Validating release files: ${releaseFileCandidates?.join(', ') ?? 'undefined'}`);
    const validatedReleaseFiles: string[] = await validateReleaseFiles(releaseFileCandidates);
    logger.d(`Release files validated: ${validatedReleaseFiles.join(', ')}`);

    // 추가 파일 존재 여부 확인
    logger.d('Checking for additional files (whatsNewDir, mappingFile, debugSymbols).');
    if (isNotNil(whatsNewDir) && whatsNewDir.length > 0 && !fs.existsSync(whatsNewDir)) {
      throw new Error(`Unable to find 'whatsnew' directory @ ${whatsNewDir}`);
    } else if (whatsNewDir) {
      logger.d(`'whatsnew' directory found @ ${whatsNewDir}`);
    }

    if (isNotNil(mappingFile) && mappingFile.length > 0 && !fs.existsSync(mappingFile)) {
      throw new Error(`Unable to find 'mappingFile' @ ${mappingFile}`);
    } else if (mappingFile) {
      logger.d(`'mappingFile' found @ ${mappingFile}`);
    }

    if (isNotNil(debugSymbols) && debugSymbols.length > 0 && !fs.existsSync(debugSymbols)) {
      throw new Error(`Unable to find 'debugSymbols' @ ${debugSymbols}`);
    } else if (debugSymbols) {
      logger.d(`'debugSymbols' found @ ${debugSymbols}`);
    }
    logger.d('Additional file checks complete.');

    if (!releaseNotes && whatsNewDir) {
      releaseNotes = await readLocalizedReleaseNotes(whatsNewDir);
    }

    // Dry-run: 위의 모든 검증을 통과한 상태에서 Play API 변경 전에 중단한다 (업로드 없음).
    if (dryRun) {
      logger.d('Dry-run mode: preflight validations passed; skipping Play API upload.');
      core.setOutput('dryRun', 'true');
      return;
    }

    // 업로드 실행 (3.6e+6ms = 1시간 타임아웃)
    logger.d('Initiating app upload.');
    await pTimeout(
      runUpload({
        packageName,
        track,
        inAppUpdatePriority: inAppUpdatePriorityInt,
        userFraction: userFractionFloat,
        whatsNewDir,
        mappingFile,
        debugSymbols,
        name: releaseName,
        changesNotSentForReview,
        existingEditId,
        status: releaseStatus,
        releaseFiles: validatedReleaseFiles,
        releaseNotes,
      }),
      {
        milliseconds: 3.6e6,
      }
    );
    logger.d('App upload process completed successfully.');
  } catch (error: unknown) {
    core.setFailed(normalizeError(error).message);
  } finally {
    if (core.getInput('serviceAccountJsonPlainText', { required: false })) {
      await cleanupServiceAccountJsonFile();
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
): Promise<void> {
  if (serviceAccountJson && serviceAccountJsonRaw) {
    throw new Error("Provide only one of 'serviceAccountJsonPlainText' or 'serviceAccountJson'");
  }

  if (serviceAccountJsonRaw) {
    validateServiceAccountJsonPayload(serviceAccountJsonRaw, 'serviceAccountJsonPlainText');
    const tempDir = createSecureTempDir('android-support-service-account-');
    const serviceAccountFile = path.join(tempDir, SERVICE_ACCOUNT_FILE_NAME);
    await writeFile(serviceAccountFile, serviceAccountJsonRaw, {
      encoding: 'utf8',
      mode: 0o600,
    });
    generatedServiceAccountFile = serviceAccountFile;
    core.exportVariable('GOOGLE_APPLICATION_CREDENTIALS', serviceAccountFile);
  } else if (serviceAccountJson) {
    const serviceAccountFile = resolveSecureFile(serviceAccountJson, 'serviceAccountJson', {
      extensions: ['.json'],
      maxBytes: SERVICE_ACCOUNT_JSON_MAX_BYTES,
    });
    const serviceAccountJsonText = await fs.promises.readFile(serviceAccountFile, 'utf8');
    validateServiceAccountJsonPayload(String(serviceAccountJsonText), 'serviceAccountJson');
    core.exportVariable('GOOGLE_APPLICATION_CREDENTIALS', serviceAccountFile);
  } else {
    // 둘 다 제공되지 않은 경우 오류
    throw new Error("You must provide one of 'serviceAccountJsonPlainText' or 'serviceAccountJson' to use this action");
  }
}

/**
 * 앱 서명 실행 함수
 * APK/AAB 파일에 서명을 추가
 */
async function signRun() {
  let signingKeyTempDir: string | undefined;
  try {
    if (process.env.DEBUG_ACTION === 'true') {
      logger.d('DEBUG FLAG DETECTED, SHORTCUTTING ACTION.');
      return;
    }

    // 서명에 필요한 입력값 가져오기
    const releaseDir = requireInputValue(core.getInput('releaseDirectory'), 'releaseDirectory');
    const signingKeyBase64 = requireInputValue(core.getInput('signingKeyBase64'), 'signingKeyBase64');
    const alias = requireInputValue(core.getInput('alias'), 'alias');
    const keyStorePassword = requireInputValue(core.getInput('keyStorePassword'), 'keyStorePassword');
    const keyPassword = optionalInputValue(core.getInput('keyPassword'));

    console.log(`Preparing to sign key @ ${safeBasenameForLog(releaseDir)} with signing key`);

    // 1. 릴리스 파일 찾기
    const releaseFiles = io.findReleaseFiles(releaseDir);
    if (releaseFiles !== undefined && releaseFiles.length !== 0) {
      // 2. 서명 키 디코딩 및 저장
      signingKeyTempDir = createSecureTempDir('android-support-signing-');
      const signingKey = path.join(signingKeyTempDir, SIGNING_KEY_FILE_NAME);
      fs.writeFileSync(signingKey, signingKeyBase64, { encoding: 'base64', mode: 0o600 });

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
          throw new Error(`No valid release file to sign: ${releaseFilePath}`);
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
      const onlySignedReleaseFile = signedReleaseFiles.at(0);
      if (signedReleaseFiles.length === 1 && onlySignedReleaseFile) {
        core.exportVariable(`SIGNED_RELEASE_FILE`, onlySignedReleaseFile);
        core.setOutput('signedReleaseFile', onlySignedReleaseFile);
      }
      console.log('Releases signed!');
    } else {
      logger.e('No release files (.apk or .aab) could be found. Abort.');
      core.setFailed('No release files (.apk or .aab) could be found.');
    }
  } catch (error) {
    core.setFailed(normalizeError(error).message);
  } finally {
    if (signingKeyTempDir) {
      try {
        fs.rmSync(signingKeyTempDir, { recursive: true, force: true });
        logger.d(`Cleaned up temporary signing key directory ${safeBasenameForLog(signingKeyTempDir)}`);
      } catch (cleanupError: unknown) {
        logger.w(`Failed to clean up temporary signing key directory: ${normalizeError(cleanupError).message}`);
      }
    }
  }
}

async function getReleaseNotes(source: string, path: string | undefined, content: string | undefined): Promise<string | undefined> {
  if (content) {
    logger.d('Using release notes provided directly.');
    return content;
  } else if (source === 'file' && path) {
    logger.d(`Reading release notes from file: ${safeBasenameForLog(path)}`);
    try {
      const releaseNotesPath = resolveSecureFile(path, 'releaseNotesPath', {
        maxBytes: RELEASE_NOTES_MAX_BYTES,
      });
      return await fs.promises.readFile(releaseNotesPath, 'utf8');
    } catch (error) {
      logger.e(`Failed to read release notes file: ${safeBasenameForLog(path)}. Error: ${normalizeError(error).message}`);
      throw new Error(`Failed to read release notes file ${safeBasenameForLog(path)}: ${normalizeError(error).message}`);
    }
  } else if (source === 'file') {
    throw new Error("releaseNotesSource is 'file' but releaseNotesPath was not provided.");
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
      logger.e(`Failed to get git commits: ${normalizeError(err).message}`);
      throw new Error(`Failed to generate release notes from git commits: ${normalizeError(err).message}`);
    }
  } else {
    logger.d('No release notes source specified or invalid source.');
    return undefined;
  }
}

export const __testables = {
  cleanupServiceAccountJsonFile,
  normalizeError,
  validateServiceAccountJson,
  signRun,
  getReleaseNotes,
};
