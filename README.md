# flakewatch

Live tracking of flaky tests in large public repositories.

## Setup

Ensure that you have NodeJS and NPM installed. Then, run:

```bash
cd backend && npm install
```

## Running the server

```bash
cd backend && npm run dev
```

Then navigate to `http://localhost:3000/list.csv` in your browser to download the live list of flaky tests.

## Adding Projects & Configuration

To add a new project, create a new JSON file in the `backend/projects` directory. The file should have the following structure:

```json
{
    "name": "json-file-name",
    "gitURL": "https://github.com/some/repo.git",
    "branch": "master"
}
```

To configure other aspects of the server, edit the `backend/projects/_config.json` file.
