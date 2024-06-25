import * as core from '@actions/core'
import * as fs from "fs"
import { runUpload } from "./edits"
import { validateInAppUpdatePriority, validateReleaseFiles, validateStatus, validateUserFraction } from "./input-validation"
import { unlink, writeFile } from 'fs/promises'
import pTimeout from 'p-timeout'
import * as io from "./io-utils";
import path from "path";
import {signAabFile, signApkFile} from "./signing";

export async function run() {
    try {
        const type = core.getInput('type', { required: true });
        if(type === 'upload') {
            await uploadRun();
        } else if (type === 'sign') {
            await signRun();
        } else {
            core.setFailed(`Unknown type: ${type}`);
        }
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed('Unknown error occurred.')
        }
    } finally {
        if (core.getInput('serviceAccountJsonPlainText', { required: false})) {
            // Cleanup our auth file that we created.
            core.debug('Cleaning up service account json file');
            await unlink('./serviceAccountJson.json');
        }
    }
}

export async function uploadRun() {
    try {
        const serviceAccountJson = core.getInput('serviceAccountJson', { required: false });
        const serviceAccountJsonRaw = core.getInput('serviceAccountJsonPlainText', { required: false});
        const packageName = core.getInput('packageName', { required: true });
        const releaseFile = core.getInput('releaseFile', { required: false });
        const releaseFiles = core.getInput('releaseFiles', { required: false })
            ?.split(',')
            ?.filter(x => x !== '');
        const releaseName = core.getInput('releaseName', { required: false });
        const track = core.getInput('track', { required: true });
        const inAppUpdatePriority = core.getInput('inAppUpdatePriority', { required: false });
        const userFraction = core.getInput('userFraction', { required: false })
        const status = core.getInput('status', { required: false });
        const whatsNewDir = core.getInput('whatsNewDirectory', { required: false });
        const mappingFile = core.getInput('mappingFile', { required: false });
        const debugSymbols = core.getInput('debugSymbols', { required: false });
        const changesNotSentForReview = core.getInput('changesNotSentForReview', { required: false }) == 'true';
        const existingEditId = core.getInput('existingEditId');

        await validateServiceAccountJson(serviceAccountJsonRaw, serviceAccountJson)

        // Validate user fraction
        let userFractionFloat: number | undefined
        if (userFraction) {
            userFractionFloat = parseFloat(userFraction)
        } else {
            userFractionFloat = undefined
        }
        await validateUserFraction(userFractionFloat)

        // Validate release status
        await validateStatus(status, userFractionFloat != undefined && !isNaN(userFractionFloat))

        // Validate the inAppUpdatePriority to be a valid number in within [0, 5]
        let inAppUpdatePriorityInt: number | undefined
        if (inAppUpdatePriority) {
            inAppUpdatePriorityInt = parseInt(inAppUpdatePriority)
        } else {
            inAppUpdatePriorityInt = undefined
        }
        await validateInAppUpdatePriority(inAppUpdatePriorityInt)

        // Check release files while maintaining backward compatibility
        if (releaseFile) {
            core.warning(`WARNING!! 'releaseFile' is deprecated and will be removed in a future release. Please migrate to 'releaseFiles'`)
        }
        const validatedReleaseFiles: string[] = await validateReleaseFiles(releaseFiles ?? [releaseFile])

        if (whatsNewDir != undefined && whatsNewDir.length > 0 && !fs.existsSync(whatsNewDir)) {
            core.warning(`Unable to find 'whatsnew' directory @ ${whatsNewDir}`);
        }

        if (mappingFile != undefined && mappingFile.length > 0 && !fs.existsSync(mappingFile)) {
            core.warning(`Unable to find 'mappingFile' @ ${mappingFile}`);
        }

        if (debugSymbols != undefined && debugSymbols.length > 0 && !fs.existsSync(debugSymbols)) {
            core.warning(`Unable to find 'debugSymbols' @ ${debugSymbols}`);
        }

        await pTimeout(
            runUpload(
                packageName,
                track,
                inAppUpdatePriorityInt,
                userFractionFloat,
                whatsNewDir,
                mappingFile,
                debugSymbols,
                releaseName,
                changesNotSentForReview,
                existingEditId,
                status,
                validatedReleaseFiles
            ),
            {
                milliseconds: 3.6e+6
            }
        )
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed('Unknown error occurred.')
        }
    } finally {
        if (core.getInput('serviceAccountJsonPlainText', { required: false})) {
            // Cleanup our auth file that we created.
            core.debug('Cleaning up service account json file');
            await unlink('./serviceAccountJson.json');
        }
    }
}

async function validateServiceAccountJson(serviceAccountJsonRaw: string | undefined, serviceAccountJson: string | undefined): Promise<string | undefined> {
    if (serviceAccountJson && serviceAccountJsonRaw) {
        // If the user provided both, print a warning one will be ignored
        core.warning('Both \'serviceAccountJsonPlainText\' and \'serviceAccountJson\' were provided! \'serviceAccountJson\' will be ignored.')
    }

    if (serviceAccountJsonRaw) {
        // If the user has provided the raw plain text, then write to file and set appropriate env variable
        const serviceAccountFile = "./serviceAccountJson.json";
        await writeFile(serviceAccountFile, serviceAccountJsonRaw, {
            encoding: 'utf8'
        });
        core.exportVariable("GOOGLE_APPLICATION_CREDENTIALS", serviceAccountFile)
    } else if (serviceAccountJson) {
        // If the user has provided the json path, then set appropriate env variable
        core.exportVariable("GOOGLE_APPLICATION_CREDENTIALS", serviceAccountJson)
    } else {
        // If the user provided neither, fail and exit
        return Promise.reject("You must provide one of 'serviceAccountJsonPlainText' or 'serviceAccountJson' to use this action")
    }
}

async function signRun() {
    try {
        if (process.env.DEBUG_ACTION === 'true') {
            core.debug("DEBUG FLAG DETECTED, SHORTCUTTING ACTION.")
            return;
        }

        const releaseDir = core.getInput('releaseDirectory');
        const signingKeyBase64 = core.getInput('signingKeyBase64');
        const alias = core.getInput('alias');
        const keyStorePassword = core.getInput('keyStorePassword');
        const keyPassword = core.getInput('keyPassword');

        console.log(`Preparing to sign key @ ${releaseDir} with signing key`);

        // 1. Find release files
        const releaseFiles = io.findReleaseFiles(releaseDir);
        if (releaseFiles !== undefined && releaseFiles.length !== 0) {
            // 3. Now that we have a release files, decode and save the signing key
            const signingKey = path.join(releaseDir, 'signingKey.jks');
            fs.writeFileSync(signingKey, signingKeyBase64, 'base64');

            // 4. Now zipalign and sign each one of the the release files
            const signedReleaseFiles:string[] = [];
            let index = 0;
            for (const releaseFile of releaseFiles) {
                core.debug(`Found release to sign: ${releaseFile.name}`);
                const releaseFilePath = path.join(releaseDir, releaseFile.name);
                let signedReleaseFile = '';
                if (releaseFile.name.endsWith('.apk')) {
                    signedReleaseFile = await signApkFile(releaseFilePath, signingKey, alias, keyStorePassword, keyPassword);
                } else if (releaseFile.name.endsWith('.aab')) {
                    signedReleaseFile = await signAabFile(releaseFilePath, signingKey, alias, keyStorePassword, keyPassword);
                } else {
                    core.error('No valid release file to sign, abort.');
                    core.setFailed('No valid release file to sign.');
                }

                // Each signed release file is stored in a separate variable + output.
                core.exportVariable(`SIGNED_RELEASE_FILE_${index}`, signedReleaseFile);
                core.setOutput(`signedReleaseFile${index}`, signedReleaseFile);
                signedReleaseFiles.push(signedReleaseFile);
                ++index;
            }

            // All signed release files are stored in a merged variable + output.
            core.exportVariable(`SIGNED_RELEASE_FILES`, signedReleaseFiles.join(":"));
            core.setOutput('signedReleaseFiles', signedReleaseFiles.join(":"));
            core.exportVariable(`NOF_SIGNED_RELEASE_FILES`, `${signedReleaseFiles.length}`);
            core.setOutput(`nofSignedReleaseFiles`, `${signedReleaseFiles.length}`);

            // When there is one and only one signed release file, stoire it in a specific variable + output.
            if (signedReleaseFiles.length == 1) {
                core.exportVariable(`SIGNED_RELEASE_FILE`, signedReleaseFiles[0]);
                core.setOutput('signedReleaseFile', signedReleaseFiles[0]);
            }
            console.log('Releases signed!');
        } else {
            core.error("No release files (.apk or .aab) could be found. Abort.");
            core.setFailed('No release files (.apk or .aab) could be found.');
        }
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed('Unknown error occurred.')
        }
    }
}

void run();