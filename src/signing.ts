/**
 * APK/AAB 파일 서명 관련 유틸리티
 * Android 앱 서명을 위한 zipalign, apksigner, jarsigner 도구 사용
 */
import { exec } from '@actions/exec';
import * as io from '@actions/io';
import * as path from 'path';
import * as fs from 'fs';
import * as logger from './utils/logger';

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

  // zipalign 실행 파일 찾기
  const buildToolsVersion = process.env.BUILD_TOOLS_VERSION || '33.0.0';
  const androidHome = process.env.ANDROID_HOME;
  const buildTools = path.join(androidHome!, `build-tools/${buildToolsVersion}`);
  if (!fs.existsSync(buildTools)) {
    logger.e(`Couldnt find the Android build tools @ ${buildTools}`);
  }

  const zipAlign = path.join(buildTools, 'zipalign');
  logger.d(`Found 'zipalign' @ ${zipAlign}`);

  // APK 파일 정렬
  const alignedApkFile = apkFile.replace('.apk', '-aligned.apk');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  await exec(`"${zipAlign}"`, ['-c', '-v', '4', apkFile]);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  await exec(`"cp"`, [apkFile, alignedApkFile]);

  logger.d('Signing APK file');

  // apksigner 경로 찾기
  const apkSigner = path.join(buildTools, 'apksigner');
  logger.d(`Found 'apksigner' @ ${apkSigner}`);

  // apksigner로 서명
  const signedApkFile = apkFile.replace('.apk', '-signed.apk');
  const args = ['sign', '--ks', signingKeyFile, '--ks-key-alias', alias, '--ks-pass', `pass:${keyStorePassword}`, '--out', signedApkFile];

  if (keyPassword) {
    args.push('--key-pass', `pass:${keyPassword}`);
  }
  args.push(alignedApkFile);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  await exec(`"${apkSigner}"`, args);

  // 서명 검증
  logger.d('Verifying Signed APK');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
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
  // jarsigner 경로 찾기
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
  const jarSignerPath = await io.which('jarsigner', true);
  logger.d(`Found 'jarsigner' @ ${jarSignerPath}`);
  const args = ['-keystore', signingKeyFile, '-storepass', keyStorePassword];

  if (keyPassword) {
    args.push('-keypass', keyPassword);
  }

  args.push(aabFile, alias);

  // jarsigner로 서명
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  await exec(`"${jarSignerPath}"`, args);

  return aabFile;
}
