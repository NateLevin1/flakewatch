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
