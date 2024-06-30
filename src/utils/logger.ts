import * as core from '@actions/core';

export function d(message: string) {
  console.debug(message);
  core.debug(message);
}

export function e(message: string) {
  console.error(message);
  core.error(message);
}

export function i(message: string) {
  console.info(message);
  core.info(message);
}

export function w(message: string) {
  console.warn(message);
  core.warning(message);
}
