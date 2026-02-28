# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-01
**Commit:** 520abc3e
**Branch:** main

## OVERVIEW
TypeScript GitHub Action for uploading Android releases to Google Play. It uses `@googleapis/androidpublisher` to interact with the Google Play Console API.

## STRUCTURE
```
.
├── src/            # Source code (TypeScript)
│   ├── utils/      # Helper functions
│   └── main.ts     # Action entry point
├── __tests__/      # Unit and integration tests (Jest)
├── lib/            # Compiled output via ncc (Committed for GitHub Actions)
├── action.yml      # GitHub Action interface definition
└── coverage/       # Generated test coverage artifacts
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Modify Action Inputs/Outputs | `action.yml`, `src/main.ts`, `src/input-validation.ts` | Update `README.md` and `action.yml` when changing inputs. |
| Modify Google Play API interaction | `src/edits.ts` | Handles the Google Play Edit workflow (insert, commit). |
| Validation logic | `src/input-validation.ts` | Contains logic for status, userFraction, inAppUpdatePriority validation. |
| Unit/Integration Testing | `__tests__/` | Uses `github-action-ts-run-api` for action simulation in `main.test.ts`. |

## CONVENTIONS
- **Package Manager:** Uses Bun (`bun.lockb`) instead of npm/yarn.
- **Linting & Formatting:** 150-char print width, single quotes. Enforced by Prettier and ESLint (strict).
- **TypeScript:** Target ES2018, commonjs modules. Compiled with `@vercel/ncc` to a single `lib/index.js` file.
- **Testing:** Jest with `ts-jest` for running TypeScript tests. Data-driven tests using arrays of valid/invalid inputs are preferred.

## ANTI-PATTERNS (THIS PROJECT)
- **DO NOT** use the `releaseFile` input parameter; it is deprecated. Use `releaseFiles` instead.
- **NEVER** provide `userFraction` when the status is `completed` or `draft`.
- **ALWAYS** provide `userFraction` (between 0.0 and 1.0) when the status is `halted` or `inProgress`.
- **NEVER** provide `inAppUpdatePriority` outside the range [0, 5].
- **DO NOT** provide both `serviceAccountJsonPlainText` and `serviceAccountJson`. Only one is needed.

## COMMANDS
```bash
# Install dependencies
bun install

# Build the action (generates lib/index.js)
bun run build

# Run tests
bun run jest

# Run tests with coverage
bun run test:coverage
```

## NOTES
- **Fragile CI Setup:** The `manual-build.yml` workflow uses shell tools (`awk`, `sed`) to manage versions in `package.json`, which is fragile. It also uses an undefined matrix variable (`${{ matrix.bun }}`) for cache keys.
- **Local Artifacts:** `.idea/` and `coverage/` directories might exist locally but should be gitignored.
- **Package Name Mismatch:** The repository URL (`upload-google-play`), package name (`support-google-play-in-android`), and local directory (`android-support`) are inconsistent.
