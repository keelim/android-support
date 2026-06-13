/**
 * APK/AAB 파일 서명 관련 유틸리티
 * Android 앱 서명을 위한 zipalign, apksigner, jarsigner 도구 사용
 */
import { exec } from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as logger from './utils/logger';
import * as core from '@actions/core';
import { assertPathInsideRoot, normalizeUnknownError, safeBasenameForLog } from './utils/security-utils';

const DEFAULT_BUILD_TOOLS_VERSION = '33.0.0';
const ANDROID_BUILD_TOOLS_VERSION_PATTERN = /^\d+(?:\.\d+){1,2}(?:[-._A-Za-z0-9]+)?$/;
const STORE_PASSWORD_ENV = 'ANDROID_SUPPORT_KEYSTORE_PASSWORD';
const KEY_PASSWORD_ENV = 'ANDROID_SUPPORT_KEY_PASSWORD';

function assertExecutableUnderRoot(executablePath: string, rootPath: string, label: string): string {
  let realExecutablePath: string;
  try {
    realExecutablePath = fs.realpathSync(executablePath);
  } catch (error: unknown) {
    throw new Error(`Unable to resolve ${label} executable ${safeBasenameForLog(executablePath)}: ${normalizeUnknownError(error).message}`);
  }

  assertPathInsideRoot(realExecutablePath, rootPath, label);

  try {
    fs.accessSync(realExecutablePath, fs.constants.X_OK);
  } catch (error: unknown) {
    throw new Error(`Unable to execute ${label} ${safeBasenameForLog(executablePath)}: ${normalizeUnknownError(error).message}`);
  }

  return realExecutablePath;
}

function resolveAndroidBuildTools(): { zipAlign: string; apkSigner: string } {
  const buildToolsVersion = process.env.BUILD_TOOLS_VERSION || DEFAULT_BUILD_TOOLS_VERSION;
  if (!ANDROID_BUILD_TOOLS_VERSION_PATTERN.test(buildToolsVersion)) {
    throw new Error(`BUILD_TOOLS_VERSION must be a version string such as 35.0.0. Got ${buildToolsVersion}`);
  }

  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome || !path.isAbsolute(androidHome)) {
    throw new Error('ANDROID_HOME must be set to an absolute Android SDK path to sign APK files.');
  }

  const androidHomeRealPath = fs.realpathSync(androidHome);
  const buildTools = path.join(androidHomeRealPath, 'build-tools', buildToolsVersion);
  const buildToolsRealPath = fs.realpathSync(buildTools);
  assertPathInsideRoot(buildToolsRealPath, androidHomeRealPath, 'Android build tools');

  return {
    zipAlign: assertExecutableUnderRoot(path.join(buildToolsRealPath, 'zipalign'), androidHomeRealPath, 'zipalign'),
    apkSigner: assertExecutableUnderRoot(path.join(buildToolsRealPath, 'apksigner'), androidHomeRealPath, 'apksigner'),
  };
}

function resolveJavaHomeTool(toolName: string): string {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome || !path.isAbsolute(javaHome)) {
    throw new Error(`JAVA_HOME must be set to an absolute JDK path to use ${toolName}.`);
  }

  const javaHomeRealPath = fs.realpathSync(javaHome);
  return assertExecutableUnderRoot(path.join(javaHomeRealPath, 'bin', toolName), javaHomeRealPath, toolName);
}

function buildSecretEnv(keyStorePassword: string, keyPassword?: string): { [key: string]: string } {
  core.setSecret(keyStorePassword);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env[STORE_PASSWORD_ENV] = keyStorePassword;
  if (keyPassword) {
    core.setSecret(keyPassword);
    env[KEY_PASSWORD_ENV] = keyPassword;
  }
  return env;
}

/**
 * APK 파일 서명
 * 1. zipalign으로 APK 파일 정렬
 * 2. apksigner로 서명
 * 3. 서명 검증
 *
 * @param apkFile - 서명할 APK 파일 경로
 * @param signingKeyFile - 서명 키 파일 경로
 * @param alias - 키스토어 별칭
 * @param keyStorePassword - 키스토어 비밀번호
 * @param keyPassword - 키 비밀번호 (선택사항)
 * @returns 서명된 APK 파일 경로
 */
export async function signApkFile(
  apkFile: string,
  signingKeyFile: string,
  alias: string,
  keyStorePassword: string,
  keyPassword?: string
): Promise<string> {
  logger.d('Zipaligning APK file');

  const { zipAlign, apkSigner } = resolveAndroidBuildTools();
  logger.d(`Found 'zipalign' @ ${safeBasenameForLog(zipAlign)}`);

  // APK 파일 정렬
  const alignedApkFile = apkFile.replace('.apk', '-aligned.apk');
  await exec(`"${zipAlign}"`, ['-c', '-v', '4', apkFile]);
  fs.copyFileSync(apkFile, alignedApkFile);

  logger.d('Signing APK file');

  logger.d(`Found 'apksigner' @ ${safeBasenameForLog(apkSigner)}`);

  // apksigner로 서명
  const signedApkFile = apkFile.replace('.apk', '-signed.apk');
  const args = ['sign', '--ks', signingKeyFile, '--ks-key-alias', alias, '--ks-pass', `env:${STORE_PASSWORD_ENV}`, '--out', signedApkFile];

  if (keyPassword) {
    args.push('--key-pass', `env:${KEY_PASSWORD_ENV}`);
  }
  args.push(alignedApkFile);
  await exec(`"${apkSigner}"`, args, { env: buildSecretEnv(keyStorePassword, keyPassword) });

  // 서명 검증
  logger.d('Verifying Signed APK');
  await exec(`"${apkSigner}"`, ['verify', signedApkFile]);

  return signedApkFile;
}

/**
 * AAB 파일 서명
 * jarsigner를 사용하여 Android App Bundle 서명
 *
 * @param aabFile - 서명할 AAB 파일 경로
 * @param signingKeyFile - 서명 키 파일 경로
 * @param alias - 키스토어 별칭
 * @param keyStorePassword - 키스토어 비밀번호
 * @param keyPassword - 키 비밀번호 (선택사항)
 * @returns 서명된 AAB 파일 경로
 */
export async function signAabFile(
  aabFile: string,
  signingKeyFile: string,
  alias: string,
  keyStorePassword: string,
  keyPassword?: string
): Promise<string> {
  logger.d('Signing AAB file');
  const jarSignerPath = resolveJavaHomeTool('jarsigner');
  logger.d(`Found 'jarsigner' @ ${safeBasenameForLog(jarSignerPath)}`);
  const args = ['-keystore', signingKeyFile, '-storepass:env', STORE_PASSWORD_ENV];

  if (keyPassword) {
    args.push('-keypass:env', KEY_PASSWORD_ENV);
  }

  args.push(aabFile, alias);

  // jarsigner로 서명
  await exec(`"${jarSignerPath}"`, args, { env: buildSecretEnv(keyStorePassword, keyPassword) });
  await exec(`"${jarSignerPath}"`, ['-verify', '-certs', '-verbose', aabFile]);

  return aabFile;
}

export const __testables = {
  resolveAndroidBuildTools,
  resolveJavaHomeTool,
  buildSecretEnv,
};
