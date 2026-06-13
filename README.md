# Upload Android release to the Play Store

(forked from https://github.com/r0adkll/upload-google-play)

This GitHub Action uploads Android `.apk` or `.aab` files to Google Play Console and can also sign release artifacts before upload.

## Inputs

`type` is the only input marked required in `action.yml`. The action then enforces the upload or sign inputs at runtime.

| Input | Description | Required |
| --- | --- | --- |
| `type` | Operation mode: `upload` or `sign`. | Yes |

### Upload inputs

Use these inputs with `type: upload`.

| Input | Description | Required |
| --- | --- | --- |
| `releaseFiles` | Android release file paths to upload. Accepts comma-separated paths and glob patterns. Use this instead of deprecated `releaseFile`. | Yes |
| `packageName` | Google Play package name / application id, for example `com.example.myapp`. The app must already exist in Play Console. | Yes |
| `track` | Target track. Use `internalsharing` for internal app sharing, or a Play track such as `internal`, `alpha`, `beta`, or `production`. | Yes |
| `serviceAccountJsonPlainText` | Raw service account JSON, usually supplied from a secret. The action writes it to a per-run temp file and removes it after upload. | One credential input |
| `serviceAccountJson` | Path to a service account JSON file under the workspace or runner temp directory. | One credential input |
| `releaseName` | Optional release name. If omitted, Google Play Console provides the default. | No |
| `inAppUpdatePriority` | Integer in `[0, 5]`; defaults to `0`. | No |
| `userFraction` | Staged rollout fraction. Provide it for `inProgress` or `halted`; do not provide it for `completed` or `draft`. | Conditional |
| `status` | One of `completed`, `inProgress`, `halted`, or `draft`; defaults to `completed`. | No |
| `changesNotSentForReview` | Whether the edit should wait to be sent for review from Play Console; defaults to `false`. | No |
| `existingEditId` | Existing unpublished edit id to append to instead of creating a new edit. | No |
| `dryRun` | Runs validations and stops before any Google Play API upload. Sets the `dryRun` output to `true`. | No |
| `releaseNotes` | Direct release notes text. This has the highest release-note precedence. | No |
| `releaseNotesSource` | `none`, `file`, or `git-commits`; defaults to `none`. | No |
| `releaseNotesPath` | File path used when `releaseNotesSource: file`. | Conditional |
| `whatsNewDirectory` | Directory of localized release notes files named `whatsnew-<locale>`. Used when no direct/file/git release notes are supplied. | No |
| `mappingFile` | ProGuard/R8 mapping file. Currently uploaded only for APK artifacts; AAB uploads skip this file. | No |
| `debugSymbols` | Native debug symbols `.zip` file or directory. Currently uploaded only for APK artifacts; AAB uploads skip this file. | No |
| `releaseFile` | Deprecated single release file input. Use `releaseFiles`. | No |

Provide exactly one of `serviceAccountJsonPlainText` or `serviceAccountJson`. Providing both fails the action, and providing neither fails upload runs.

### Release notes

Release-note precedence is:

1. `releaseNotes`
2. `releaseNotesSource: file` with `releaseNotesPath`
3. `releaseNotesSource: git-commits`
4. `whatsNewDirectory`

`releaseNotes` and `releaseNotesSource: file` are uploaded as a single `en-US` localized text entry. `releaseNotesSource: git-commits` runs `git log -10 --pretty=format:%s`, uses the last 10 commit subject lines, and also uploads them as `en-US`; this requires checkout history in the workflow and is not configurable today.

Use `whatsNewDirectory` for localized release notes. Files must be named like `whatsnew-en`, `whatsnew-en-US`, or `whatsnew-ko`; the action accepts two or three letters with an optional `-` plus a 2-8 character region/script suffix. This is the action's filename pattern, not a full BCP 47 parser. Files must be regular files, must not be symlinks, and each file is limited to 128 KiB.

### Upload artifact notes

`mappingFile` and `debugSymbols` are consumed only in the APK upload branch. If `releaseFiles` contains an `.aab`, the bundle is uploaded without mapping or native-symbol upload calls.

When `debugSymbols` is a directory, the action creates a zip in memory. Zip entries are relative to the supplied directory root, symlinks are rejected, and the directory traversal is bounded by file count, depth, and byte limits.

### Sign inputs

Use these inputs with `type: sign`.

| Input | Description | Required |
| --- | --- | --- |
| `releaseDirectory` | Directory containing release files to sign. Only direct child `.apk` and `.aab` files are discovered; nested directories are not searched. | Yes |
| `signingKeyBase64` | Base64-encoded signing key / keystore. | Yes |
| `alias` | Keystore alias. | Yes |
| `keyStorePassword` | Keystore password. | Yes |
| `keyPassword` | Key password. If omitted, the keystore password is used by the signing tools where applicable. | No |

APK signing requires an Android SDK with `ANDROID_HOME` set to an absolute SDK path. The action looks for `zipalign` and `apksigner` under `$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION`; `BUILD_TOOLS_VERSION` defaults to `33.0.0`.

AAB signing requires `JAVA_HOME` set to an absolute JDK path with `bin/jarsigner` available.

`DEBUG_ACTION=true` is a sign-mode escape hatch for local action debugging. When set, sign mode logs `DEBUG FLAG DETECTED, SHORTCUTTING ACTION.` and returns before reading inputs or signing files. Do not set it in production workflows.

## Outputs

| Output | Environment variable | Description |
| --- | --- | --- |
| `internalSharingDownloadUrl` | `INTERNAL_SHARING_DOWNLOAD_URL` | Last download URL produced for upload runs. For `internalsharing`, this is returned by the internal sharing API. For other tracks, the action infers a Play test URL from package name and uploaded version code. |
| `internalSharingDownloadUrls` | `INTERNAL_SHARING_DOWNLOAD_URLS` | JSON array of all download URLs produced for upload runs. |
| `dryRun` | n/a | `true` when an upload run completes preflight validation and exits because `dryRun: true` was provided. |
| `signedReleaseFile` | `SIGNED_RELEASE_FILE` | Signed release file path when exactly one file was signed. |
| `signedReleaseFiles` | `SIGNED_RELEASE_FILES` | Colon-separated list of signed release file paths. |
| `nofSignedReleaseFiles` | `NOF_SIGNED_RELEASE_FILES` | Number of signed release files. |
| `signedReleaseFile0` ... `signedReleaseFile12` | `SIGNED_RELEASE_FILE_0` ... `SIGNED_RELEASE_FILE_12` | Indexed signed release file outputs declared in action metadata. For more than 13 files, use `signedReleaseFiles` and `nofSignedReleaseFiles`. |

## Examples

### Upload release files

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: keelim/upload-google-play@v0.0.8
    with:
      type: upload
      serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
      packageName: com.example.myapp
      releaseFiles: app/build/outputs/bundle/release/*.aab
      track: internal
      status: completed
```

### Upload with release notes from a file

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: keelim/upload-google-play@v0.0.8
    with:
      type: upload
      serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
      packageName: com.example.myapp
      releaseFiles: app/build/outputs/apk/release/app-release.apk
      track: internal
      releaseNotesSource: file
      releaseNotesPath: release-notes/en-US.txt
```

### Dry-run upload validation

```yaml
steps:
  - uses: actions/checkout@v4
  - id: play
    uses: keelim/upload-google-play@v0.0.8
    with:
      type: upload
      dryRun: true
      serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
      packageName: com.example.myapp
      releaseFiles: app/build/outputs/apk/release/app-release.apk
      track: internal
  - run: test "${{ steps.play.outputs.dryRun }}" = "true"
```

### Sign APK/AAB files

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-java@v4
    with:
      distribution: temurin
      java-version: '17'
  - uses: android-actions/setup-android@v3
  - uses: keelim/upload-google-play@v0.0.8
    with:
      type: sign
      releaseDirectory: app/build/outputs/release
      signingKeyBase64: ${{ secrets.SIGNING_KEY_BASE64 }}
      alias: ${{ secrets.KEY_ALIAS }}
      keyStorePassword: ${{ secrets.KEYSTORE_PASSWORD }}
      keyPassword: ${{ secrets.KEY_PASSWORD }}
```

## Troubleshooting

Set the repository secret `ACTIONS_STEP_DEBUG` to `true` to see GitHub Actions debug logs from this action.

Upload debug logs include package name, track, release artifact basenames, optional artifact basenames, release-note source, and whether direct release notes were present. Secret credential contents and signing passwords are not printed; signing passwords are registered with the Actions secret masker before tool execution.

For sign mode, verify that release files are direct children of `releaseDirectory`, `ANDROID_HOME` points at an installed Android SDK for APK signing, and `JAVA_HOME` points at a JDK for AAB signing.

## Contributing

This project uses Bun.

```bash
bun install
bun run test
bun run typecheck
bun run build
```

Keep `README.md`, `action.yml`, and the runtime input/output behavior in sync. When TypeScript source changes, regenerate the committed GitHub Action bundle.

## Release bundle

The committed GitHub Action bundle is `lib/index.js`. CI and release workflows run `bun run build` and fail if `git diff --exit-code -- lib/index.js` detects a stale bundle.
