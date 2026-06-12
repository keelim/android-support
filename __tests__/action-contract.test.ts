import { readFileSync } from 'fs';

function actionInputBlock(inputName: string): string {
  const action = readFileSync('action.yml', 'utf8');
  const match = action.match(new RegExp(`^  ${inputName}:\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9_]*:|^outputs:)`, 'm'));
  if (!match) throw new Error(`Missing action input ${inputName}`);
  return match[1];
}

function mainSource(): string {
  return readFileSync('src/main.ts', 'utf8');
}

describe('action runtime contract', () => {
  test.each([
    ['type', true],
    ['packageName', false],
    ['track', false],
  ])('action.yml required flag matches runtime for %s', (inputName, runtimeRequired) => {
    const block = actionInputBlock(inputName);
    expect(mainSource()).toContain(`core.getInput('${inputName}', { required: ${String(runtimeRequired)} })`);
    expect(block).toContain(`required: ${String(runtimeRequired)}`);
  });

  test('action defaults match runtime fallback-sensitive inputs', () => {
    expect(actionInputBlock('track')).toContain("default: 'production'");
    expect(actionInputBlock('status')).toContain("default: 'completed'");
    expect(actionInputBlock('inAppUpdatePriority')).toContain("default: '0'");
  });
});
