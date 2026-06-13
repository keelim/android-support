/**
 * 릴리스 노트(what's new) 관련 유틸리티
 * Google Play Console에 업로드할 다국어 릴리스 노트 처리
 */
import * as fs from 'fs';
import * as path from 'path';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { readFile } from 'fs/promises';
import * as logger from './utils/logger';
import { isNotNil } from 'es-toolkit/predicate';
import { assertPathInsideRoot, resolveSecureDirectory, safeBasenameForLog } from './utils/security-utils';
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

const WHATS_NEW_FILE_PATTERN = /^whatsnew-(?<locale>[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/;
const WHATS_NEW_MAX_BYTES = 128 * 1024;

/**
 * 다국어 릴리스 노트 읽기
 * whatsnew 디렉토리에서 언어별 릴리스 노트 파일을 읽어 LocalizedText 배열로 변환
 *
 * @param whatsNewDir - 릴리스 노트 파일이 있는 디렉토리 경로
 * @returns 다국어 릴리스 노트 배열 또는 undefined
 */
export async function readLocalizedReleaseNotes(whatsNewDir: string | undefined): Promise<LocalizedText[] | undefined> {
  logger.d(`Executing readLocalizedReleaseNotes`);
  if (isNotNil(whatsNewDir) && whatsNewDir.length > 0) {
    const whatsNewRoot = resolveSecureDirectory(whatsNewDir, 'whatsNewDirectory');
    // whatsnew-{language} 형식의 파일 찾기
    const releaseNotes = fs.readdirSync(whatsNewRoot).filter(value => WHATS_NEW_FILE_PATTERN.test(value));

    const localizedReleaseNotes: LocalizedText[] = [];

    logger.d(`Found ${releaseNotes.length} localized whatsnew files.`);
    for (const value of releaseNotes) {
      const matches = value.match(WHATS_NEW_FILE_PATTERN) as RegExpMatchArray & { groups: { locale: string } };
      const lang = matches.groups.locale;
      const filePath = path.join(whatsNewRoot, value);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`whatsNewDirectory must not contain symbolic links: ${safeBasenameForLog(filePath)}`);
      }
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > WHATS_NEW_MAX_BYTES) {
        throw new Error(`whatsnew file is too large: ${safeBasenameForLog(filePath)}`);
      }
      assertPathInsideRoot(fs.realpathSync(filePath), whatsNewRoot, 'whatsnew file');
      const content = await readFile(filePath, 'utf-8');

      if (isNotNil(content)) {
        logger.d(`Found localized 'whatsnew-*-*' for Lang(${lang})`);
        localizedReleaseNotes.push({
          language: lang,
          text: content,
        });
      }
    }

    return localizedReleaseNotes;
  }
  return undefined;
}
