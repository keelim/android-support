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
});
