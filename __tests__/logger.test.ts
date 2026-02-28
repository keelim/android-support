jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));

import * as core from '@actions/core';
import * as logger from '../src/utils/logger';

describe('logger', () => {
  const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('d writes debug logs', () => {
    logger.d('hello');
    expect(console.debug).toHaveBeenCalledWith('hello');
    expect(core.debug).toHaveBeenCalledWith('hello');
  });

  test('e writes error logs', () => {
    logger.e('hello');
    expect(console.error).toHaveBeenCalledWith('hello');
    expect(core.error).toHaveBeenCalledWith('hello');
  });

  test('i writes info logs', () => {
    logger.i('hello');
    expect(console.info).toHaveBeenCalledWith('hello');
    expect(core.info).toHaveBeenCalledWith('hello');
  });

  test('w writes warning logs', () => {
    logger.w('hello');
    expect(console.warn).toHaveBeenCalledWith('hello');
    expect(core.warning).toHaveBeenCalledWith('hello');
  });
});
