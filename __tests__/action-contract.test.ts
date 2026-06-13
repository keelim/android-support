import { readFileSync } from 'fs';

function actionInputBlock(inputName: string): string {
  const action = readFileSync('action.yml', 'utf8');
  const match = action.match(new RegExp(`^  ${inputName}:\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9_]*:|^outputs:)`, 'm'));
  if (!match) throw new Error(`Missing action input ${inputName}`);
  const block = match[1];
  if (!block) throw new Error(`Missing action input block ${inputName}`);
  return block;
}

function actionOutputBlock(outputName: string): string {
  const action = readFileSync('action.yml', 'utf8');
  const match = action.match(new RegExp(`^  ${outputName}:\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9_]*:|^runs:)`, 'm'));
  if (!match) throw new Error(`Missing action output ${outputName}`);
  const block = match[1];
  if (!block) throw new Error(`Missing action output block ${outputName}`);
  return block;
}

function mainSource(): string {
  return readFileSync('src/main.ts', 'utf8');
}

function runtimeSource(): string {
  return [readFileSync('src/main.ts', 'utf8'), readFileSync('src/edits.ts', 'utf8')].join('\n');
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
    expect(actionInputBlock('track')).not.toContain('default:');
    expect(actionInputBlock('status')).toContain("default: 'completed'");
    expect(actionInputBlock('inAppUpdatePriority')).toContain("default: '0'");
  });

  test.each(['dryRun', 'internalSharingDownloadUrls'])('declares runtime output %s in action.yml', outputName => {
    expect(runtimeSource()).toContain(`core.setOutput('${outputName}'`);
    expect(actionOutputBlock(outputName)).toContain('description:');
  });
});
