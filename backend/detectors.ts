import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";

const exec = util.promisify(execC);

// TODO: base on page 12 of Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function runDetectors(
    qualifiedTestName: string,
    modulePath: string
) {
    // await detectIDFlakies(qualifiedTestName, modulePath);
    if (await detectNonDex(qualifiedTestName, modulePath))
        console.log(qualifiedTestName + " fails via nondex");
    // await detectIsolation(qualifiedTestName, modulePath);
    // await detectOneByOne(qualifiedTestName, modulePath);
}

export async function detectIDFlakies(
    qualifiedTestName: string,
    modulePath: string
) {
    await exec(
        `cd ${modulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=random-class-method -Ddt.randomize.rounds=10 -Ddt.detector.original_order.all_must_pass=false`
    );
    const flakyLists = JSON.parse(
        await fs.readFile(
            modulePath + "/.dtfixingtools/detection-results/flaky-lists.json",
            "utf-8"
        )
    );
}

export async function detectNonDex(
    qualifiedTestName: string,
    modulePath: string
) {
    try {
        await exec(
            `cd ${modulePath} && mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName}`
        );
    } catch (e) {
        // this is expected and is actually what we want
        const error = e as { stdout: string; stderr: string };

        const isNonDexError = error.stdout.includes(
            "Unable to execute mojo: There are test failures."
        );

        return isNonDexError;
    }
}

// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectIsolation(
    qualifiedTestName: string,
    modulePath: string
) {
    // TODO: run mvn test -Dtest=TestClass#testMethod 100 times (this is the arbitrary number used by Lam et al.)
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    qualifiedTestName: string,
    modulePath: string
) {
    // TODO: run each test before every other test
}
