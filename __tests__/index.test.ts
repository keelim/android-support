describe('index entrypoint', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('invokes run on module load', async () => {
    const runMock = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../src/main', () => ({
      run: runMock,
    }));

    await import('../src/index');

    expect(runMock).toHaveBeenCalledTimes(1);
  });

  test('sets failed when top-level run promise rejects', async () => {
    const runMock = jest.fn().mockRejectedValue('top-level panic');
    const setFailed = jest.fn();

    jest.doMock('../src/main', () => ({
      run: runMock,
    }));
    jest.doMock('@actions/core', () => ({
      setFailed,
    }));

    await import('../src/index');
    await Promise.resolve();

    expect(setFailed).toHaveBeenCalledWith('top-level panic');
  });

  test('sets failed with Error message when top-level run rejects with Error', async () => {
    const runMock = jest.fn().mockRejectedValue(new Error('top-level error'));
    const setFailed = jest.fn();

    jest.doMock('../src/main', () => ({
      run: runMock,
    }));
    jest.doMock('@actions/core', () => ({
      setFailed,
    }));

    await import('../src/index');
    await Promise.resolve();

    expect(setFailed).toHaveBeenCalledWith('top-level error');
  });
});
