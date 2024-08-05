# FlakeWatch

Live tracking of flaky tests in large public repositories.

## Setup

Ensure that you have Docker, NodeJS, and NPM installed. Then, run:

```bash
cd orchestration && npm install
```

## Running the server

```bash
cd orchestration && npm start
```

This command will build the base docker container and start the server. Expect this to take 20 minutes or more the first time you run it.

Once the server has started, you can navigate to http://localhost:8080/list.csv in your browser at any time to download the live list of flaky tests. Every midnight, the server will automatically run detectors on projects that have changed and update the list.

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

To add a new detector, create a new TypeScript file in the `backend/detectors` directory. The file should default export a function that takes a `DetectorInfo` and a `DetectorRun[]`. To add a new detection, simply `push` to the detector run array. Some error handling is done for you - if an error is thrown, the rest of your detector will be skipped and the error will be logged. Take a look at the existing detectors for examples.

> [!WARNING]  
> The detector file should not import from `detectors.ts` (types are OK, anything else will cause a crash).

## Running the Categorization Script

```bash
python3 backend/scripts/categorizeflaky.py path/to/csv
```
