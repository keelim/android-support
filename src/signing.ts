import {exec} from '@actions/exec';
import * as io from '@actions/io';
import * as path from "path";
import * as fs from "fs";
import * as logger from "./utils/logger";


export async function signApkFile(
    apkFile: string,
    signingKeyFile: string,
    alias: string,
    keyStorePassword: string,
    keyPassword?: string
): Promise<string> {

    logger.d("Zipaligning APK file");

    // Find zipalign executable
    const buildToolsVersion = process.env.BUILD_TOOLS_VERSION || '33.0.0';
    const androidHome = process.env.ANDROID_HOME;
    const buildTools = path.join(androidHome!, `build-tools/${buildToolsVersion}`);
    if (!fs.existsSync(buildTools)) {
        logger.e(`Couldnt find the Android build tools @ ${buildTools}`)
    }

    const zipAlign = path.join(buildTools, 'zipalign');
    logger.d(`Found 'zipalign' @ ${zipAlign}`);

    // Align the apk file
    const alignedApkFile = apkFile.replace('.apk', '-aligned.apk');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await exec(`"${zipAlign}"`, [
        '-c',
        '-v', '4',
        apkFile
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await exec(`"cp"`, [
        apkFile,
        alignedApkFile
    ]);

    logger.d("Signing APK file");

    // find apksigner path
    const apkSigner = path.join(buildTools, 'apksigner');
    logger.d(`Found 'apksigner' @ ${apkSigner}`);

    // apksigner sign --ks my-release-key.jks --out my-app-release.apk my-app-unsigned-aligned.apk
    const signedApkFile = apkFile.replace('.apk', '-signed.apk');
    const args = [
        'sign',
        '--ks', signingKeyFile,
        '--ks-key-alias', alias,
        '--ks-pass', `pass:${keyStorePassword}`,
        '--out', signedApkFile
    ];

    if (keyPassword) {
        args.push('--key-pass', `pass:${keyPassword}`);
    }
    args.push(alignedApkFile);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await exec(`"${apkSigner}"`, args);

    // Verify
    logger.d("Verifying Signed APK");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await exec(`"${apkSigner}"`, [
        'verify',
        signedApkFile
    ]);

    return signedApkFile
}

export async function signAabFile(
    aabFile: string,
    signingKeyFile: string,
    alias: string,
    keyStorePassword: string,
    keyPassword?: string,
): Promise<string> {
    logger.d("Signing AAB file");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
    const jarSignerPath = await io.which('jarsigner', true);
    logger.d(`Found 'jarsigner' @ ${jarSignerPath}`);
    const args = [
        '-keystore', signingKeyFile,
        '-storepass', keyStorePassword,
    ];

    if (keyPassword) {
        args.push('-keypass', keyPassword);
    }

    args.push(aabFile, alias);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await exec(`"${jarSignerPath}"`, args);

    return aabFile
}
