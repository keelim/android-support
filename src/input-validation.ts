/**
 * 입력값 검증 유틸리티
 * Google Play Console 업로드에 필요한 입력값들의 유효성 검사
 */
import fg from 'fast-glob';

/**
 * 사용자 분수(userFraction) 검증
 * 점진적 출시를 위한 사용자 비율이 0과 1 사이의 숫자인지 확인
 *
 * @param userFraction - 검증할 사용자 분수
 */
export async function validateUserFraction(userFraction: number | undefined): Promise<void> {
  if (userFraction != undefined) {
    // userFraction이 설정된 경우 기본 검증 수행
    if (isNaN(userFraction)) {
      return Promise.reject(new Error(`'userFraction' must be a number! Got ${userFraction}`));
    }
    if (userFraction >= 1 || userFraction <= 0) {
      return Promise.reject(new Error(`'userFraction' must be between 0 and 1! Got ${userFraction}`));
    }
  }
}

/**
 * 릴리스 상태 검증
 * 상태값이 유효한지, 그리고 userFraction과 호환되는지 확인
 *
 * @param status - 검증할 릴리스 상태
 * @param hasUserFraction - userFraction이 설정되어 있는지 여부
 */
export async function validateStatus(status: string | undefined, hasUserFraction: boolean): Promise<void> {
  // 상태값이 설정된 경우 기본 검증 수행
  if (status != 'completed' && status != 'inProgress' && status != 'halted' && status != 'draft') {
    return Promise.reject(
      new Error(`Invalid status provided! Must be one of 'completed', 'inProgress', 'halted', 'draft'. Got ${status ?? 'undefined'}`)
    );
  }

  // 상태에 따른 userFraction 호환성 검증
  switch (status) {
    case 'completed':
    case 'draft':
      if (hasUserFraction) {
        return Promise.reject(new Error(`Status '${status}' does not support 'userFraction'`));
      }
      break;
    case 'halted':
    case 'inProgress':
      if (!hasUserFraction) {
        return Promise.reject(new Error(`Status '${status}' requires a 'userFraction' to be set`));
      }
      break;
  }
}

/**
 * 인앱 업데이트 우선순위 검증
 * 우선순위가 0에서 5 사이의 숫자인지 확인
 *
 * @param inAppUpdatePriority - 검증할 인앱 업데이트 우선순위
 */
export async function validateInAppUpdatePriority(inAppUpdatePriority: number | undefined): Promise<void> {
  if (inAppUpdatePriority) {
    if (inAppUpdatePriority < 0 || inAppUpdatePriority > 5) {
      return Promise.reject(new Error('inAppUpdatePriority must be between 0 and 5, inclusive-inclusive'));
    }
  }
}

/**
 * 릴리스 파일 검증
 * 지정된 릴리스 파일들이 존재하는지 확인
 *
 * @param releaseFiles - 검증할 릴리스 파일 경로 배열
 * @returns 존재하는 릴리스 파일 경로 배열
 */
export async function validateReleaseFiles(releaseFiles: string[] | undefined): Promise<string[]> {
  if (!releaseFiles) {
    return Promise.reject(new Error(`You must provide 'releaseFiles' in your configuration`));
  } else {
    const files = await fg(releaseFiles);
    if (!files.length) {
      return Promise.reject(new Error(`Unable to find any release file matching ${releaseFiles.join(',')}`));
    }
    return files;
  }
}
