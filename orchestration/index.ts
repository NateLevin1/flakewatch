import "dotenv/config";
import { startServer } from "./server.js";
import { cli } from "./cli.js";

const args = process.argv.slice(2);
if (args.length > 0) {
    // run a specific project/test via command line
    cli(args);
} else {
    // run the server
    startServer();
}
