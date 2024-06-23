import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";

const exec = util.promisify(execC);

export async function detectIDFlakies(
    qualifiedTestName: string,
    modulePath: string
) {
    // TODO: how to only run for the given test?
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

export async function detectNonDex(qualifiedTestName: string) {
    // TODO: run nondex
}

// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectIsolation(qualifiedTestName: string) {
    // TODO: run mvn test -Dtest=TestClass#testMethod 100 times (this is the arbitrary number used by Lam et al.)
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(qualifiedTestName: string) {
    // TODO: run each test before every other test
}
