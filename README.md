# FlakeWatch

Live tracking of flaky tests in large public repositories.

## Setup

Ensure that you have Docker, NodeJS, and NPM installed. Then, run:

```bash
cd orchestration && npm install && npm run build
```

This command will build the base docker container and start the server. Expect this to take 20 minutes or more the first time you run it.

If your CPU is not amd64, you will need to provide the architecture as an argument to the build command. E.g., for an Apple Silicon Mac:

```bash
npm run build -- --build-arg='ARCHITECTURE=arm64'
```

## Running the server

```bash
cd orchestration && npm start
```

Once the server has started, you can navigate to http://localhost:8080/list.csv in a browser at any time to download the live list of flaky tests. Every midnight, the server will automatically run detectors on projects that have changed and update the list.

## Running Detectors for a Single Project/Test

Flakewatch can be used to run detectors on a single project and test. This has a variety of uses, including quickly categorizing a flaky test, or debugging detectors. The following commands will run detectors on a single test:

```bash
cd orchestration
npm start -- <gitURL> <commit> <test> (module) (--keep-alive)
```

The `keepAlive` option will keep the container running after the detectors have finished. The container and its files will never be automatically removed, so only use this option if you need to be able to run commands inside the container after detectors have run.

Example:

```bash
npm start -- https://github.com/NateLevin1/test-nondex 1fb14a8 com.example.HmOrderTest#testGetAlphabet
```

## Adding Projects & Configuration

To add a new project, create a new JSON file in the `orchestration/projects` directory. The file should have the following structure:

```json
{
    "name": "some-project",
    "gitURL": "https://github.com/some/repo.git",
    "branch": "master"
}
```

To configure other aspects of the server, edit the `orchestration/projects/_config.json` file.

## Adding A New Test-Level Detector

To add a new detector, create a new TypeScript file in the `backend/detectors` directory. The file should default export a function that takes a `DetectorInfo` and a `DetectorRun[]`. To register a detection, simply `push` to the detector run array provided.

A well-commented example of a detector can be found in the [`Isolation.tsx`](https://github.com/NateLevin1/flakewatch/blob/main/backend/detectors/Isolation.ts) file.

Some error handling is done for you — if an error is thrown, the rest of your detector will be skipped and the error will be logged.

The minimal detector looks like:

`backend/detectors/Something.ts`

```ts
export default async function detectSomething(
    detectorInfo: DetectorInfo,
    detectorRuns: DetectorRun[]
) {
    // ...
}
```

The first argument, `detectorInfo`, is an object containing the following properties:

```ts
{
    qualifiedTestName: string; // e.g. "com.example.SomeTest#testSomething"
    fullModulePath: string; // cd here to get to the module where the test is. does not end in a slash
    projectPath: string; // cd here to get to the project root. does not end in a slash
    module: string; // the module path to where the test is (e.g. "lib")
    allTests: string[]; // list of all tests in the module (in format "com.example.SomeTest#testSomething")
    pl: string; // the formatted maven -pl argument
    className: string; // the class name of the test (e.g. "SomeTest")
    timeoutSecs: number // how much time your detector should take
}
```

Each detector run must match the following type:

```ts
{
    test: string; // should be in the format "com.example.SomeTest#testSomething". Should always match detectorInfo.qualifiedTestName for single test detectors
    prefixMd5: string; // provide empty string if no prefix
    tool: string; // the name of the detector (should match filename)
    passed: boolean;
    failure: string | undefined; // make sure to md5 hash, provide undefined if no failure,
    log: string | undefined; // any extra logs associated with this individual run. should be somewhat short
}
```

> [!WARNING]  
> The detector file should not import from `detectors.ts` (types are OK, anything else will cause a crash).

## Running the Categorization Script

```bash
python3 backend/scripts/categorizeflaky.py path/to/csv
```
