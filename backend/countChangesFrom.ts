// run this as a script: cd backend && npx esno countChangesFrom.ts <url> <commit> <test> (checkForCommit)
import { findModifiedTests, git } from "./flakewatch.js";

const url = process.argv[2];
const commit = process.argv[3];
const test = process.argv[4];
const checkForCommit = process.argv[5];
const branch = process.argv[6];

if (!url || !commit || !test) {
    console.error("Usage: npx esno countChangesFrom.ts <url> <commit> <test>");
    process.exit(1);
}

countChangesFrom({
    url,
    test,
    commit,
});

async function countChangesFrom({
    url,
    test,
    commit,
}: {
    url: string;
    test: string;
    commit: string;
}) {
    if (!test.includes("#")) {
        const split = test.split(".");
        test = split.slice(0, -1).join(".") + "#" + split.at(-1);
    }
    console.log("Checking " + url + " for " + test + " from " + commit);

    const name = url.split("/").at(-1)!;
    try {
        await git.clone(url, name);
        await git.cwd("clones/" + name);
    } catch (e) {
        await git.cwd("clones/" + name);
        // clone fails if non-empty, so pull instead if it's already cloned
        await git.checkout(branch ?? "master");
        await git.reset(["--hard"]);
        await git.pull();
    }

    const log = await git.log({
        from: commit, //lastCheckedCommit,
        to: "HEAD",
    });

    console.log("Finding modified tests from " + log.all.length + " commits");
    const modifiedTests = await findModifiedTests(log);
    const testModifiedTimes =
        modifiedTests.filter((t) => t.testName === test)[0]?.count ?? 0;

    console.log("Most modified tests: ");
    modifiedTests
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .forEach(({ testName, count }) => {
            console.log(count + "\t(" + testName + ")");
        });

    console.log("\nModified times: " + testModifiedTimes);
    if (checkForCommit) {
        if (
            !modifiedTests.find(
                (t) => t.testName === test && t.commit === checkForCommit
            )
        ) {
            console.log(
                "[!] Commit " +
                    checkForCommit +
                    " does not directly modify " +
                    test
            );
        }
    }
}
