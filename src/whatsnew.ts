import * as fs from "fs";
import * as path from "path";
import {androidpublisher_v3} from "@googleapis/androidpublisher";
import {readFile} from 'fs/promises';
import * as logger from "./utils/logger";
import LocalizedText = androidpublisher_v3.Schema$LocalizedText;

export async function readLocalizedReleaseNotes(whatsNewDir: string | undefined): Promise<LocalizedText[] | undefined> {
    logger.d(`Executing readLocalizedReleaseNotes`);
    if (whatsNewDir != undefined && whatsNewDir.length > 0) {
        const releaseNotes = fs.readdirSync(whatsNewDir)
            .filter(value => /whatsnew-((.*-.*)|(.*))\b/.test(value));
        const pattern = /whatsnew-(?<local>(.*-.*)|(.*))/;

        const localizedReleaseNotes: LocalizedText[] = [];

        logger.d(`Found files: ${releaseNotes.toString()}`);
        for (const value of releaseNotes) {
            const matches = value.match(pattern);
            if (matches != null && matches.length == 4) {
                logger.d(`Matches for ${value} = ${matches.toString()}`);
                const lang = matches[1];
                const filePath = path.join(whatsNewDir, value);
                const content = await readFile(filePath, 'utf-8');

                if (content != undefined) {
                    logger.d(`Found localized 'whatsnew-*-*' for Lang(${lang})`);
                    localizedReleaseNotes.push(
                        {
                            language: lang,
                            text: content
                        }
                    )
                }
            }
        }

        return localizedReleaseNotes
    }
    return undefined
}
