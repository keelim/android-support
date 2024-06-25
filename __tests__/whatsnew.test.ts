import {readLocalizedReleaseNotes} from "../src/whatsnew";

test("read localized whatsnew files", async () => {
    let texts = await readLocalizedReleaseNotes("./__tests__/whatsnew");
    expect(texts).toHaveLength(2);
    expect(texts).toContainEqual({
        language: "en-US",
        text: "test_changelog_file"
    });
    expect(texts).toContainEqual({
        language: "ko-KR",
        text: "test_changelog_file"
    });
});
