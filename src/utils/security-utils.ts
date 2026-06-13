import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SecureFileOptions {
  allowedRoots?: string[];
  expectedBasenames?: string[];
  extensions?: string[];
  maxBytes?: number;
}

export function normalizeUnknownError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function safeBasenameForLog(filePath: string | undefined): string {
  if (!filePath) return '<empty>';
  return path.basename(filePath);
}

export function maskIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function secureTempRoot(): string {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

export function createSecureTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(secureTempRoot(), prefix));
}

export function getAllowedInputRoots(): string[] {
  const candidates = [process.env.GITHUB_WORKSPACE, process.cwd(), process.env.RUNNER_TEMP, os.tmpdir(), '/tmp'].filter(
    (value): value is string => !!value && value.trim().length > 0
  );

  return [...new Set(candidates.map(root => resolveExistingRoot(root)))];
}

export function resolveExistingRoot(root: string): string {
  const absoluteRoot = path.resolve(root);
  try {
    return fs.realpathSync(absoluteRoot);
  } catch {
    return absoluteRoot;
  }
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertPathInsideAllowedRoots(realPath: string, label: string, allowedRoots = getAllowedInputRoots()): void {
  const normalizedRoots = allowedRoots.map(root => resolveExistingRoot(root));
  if (!normalizedRoots.some(root => isPathInside(realPath, root))) {
    throw new Error(`${label} must be inside the workspace or runner temp directory: ${safeBasenameForLog(realPath)}`);
  }
}

export function assertPathInsideRoot(realPath: string, rootPath: string, label: string): void {
  if (!isPathInside(realPath, rootPath)) {
    throw new Error(`${label} must stay inside ${safeBasenameForLog(rootPath)}: ${safeBasenameForLog(realPath)}`);
  }
}

function inspectExistingPath(inputPath: string, label: string, allowedRoots?: string[]): { realPath: string; stats: fs.Stats } {
  if (!inputPath || inputPath.trim().length === 0) {
    throw new Error(`${label} path must not be empty`);
  }

  const absolutePath = path.resolve(inputPath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (error: unknown) {
    throw new Error(`Unable to inspect ${label} ${safeBasenameForLog(inputPath)}: ${normalizeUnknownError(error).message}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${safeBasenameForLog(inputPath)}`);
  }

  const realPath = fs.realpathSync(absolutePath);
  assertPathInsideAllowedRoots(realPath, label, allowedRoots);
  return { realPath, stats };
}

export function resolveSecureFile(inputPath: string, label: string, options: SecureFileOptions = {}): string {
  const { realPath, stats } = inspectExistingPath(inputPath, label, options.allowedRoots);

  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${safeBasenameForLog(inputPath)}`);
  }

  if (options.expectedBasenames && !options.expectedBasenames.includes(path.basename(realPath))) {
    throw new Error(`${label} must use one of these file names: ${options.expectedBasenames.join(', ')}`);
  }

  if (options.extensions && !options.extensions.includes(path.extname(realPath).toLowerCase())) {
    throw new Error(`${label} must use one of these extensions: ${options.extensions.join(', ')}`);
  }

  if (typeof options.maxBytes === 'number' && stats.size > options.maxBytes) {
    throw new Error(`${label} is too large: ${stats.size} bytes exceeds ${options.maxBytes}`);
  }

  try {
    fs.accessSync(realPath, fs.constants.R_OK);
  } catch (error: unknown) {
    throw new Error(`Unable to read ${label} file ${safeBasenameForLog(inputPath)}: ${normalizeUnknownError(error).message}`);
  }

  return realPath;
}

export function resolveSecureDirectory(inputPath: string, label: string, allowedRoots?: string[]): string {
  const { realPath, stats } = inspectExistingPath(inputPath, label, allowedRoots);

  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory: ${safeBasenameForLog(inputPath)}`);
  }

  try {
    fs.accessSync(realPath, fs.constants.R_OK);
  } catch (error: unknown) {
    throw new Error(`Unable to read ${label} directory ${safeBasenameForLog(inputPath)}: ${normalizeUnknownError(error).message}`);
  }

  return realPath;
}

export function validateServiceAccountJsonPayload(rawJson: string, label: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error: unknown) {
    throw new Error(`${label} must be valid JSON: ${normalizeUnknownError(error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a service account JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== 'service_account') {
    throw new Error(`${label} must have type "service_account"`);
  }

  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof record[field] !== 'string' || record[field].trim().length === 0) {
      throw new Error(`${label} is missing required field "${field}"`);
    }
  }
}
