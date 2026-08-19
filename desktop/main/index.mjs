import { reportStartupFailure, runDesktopApp } from "./bootstrap.mjs";

const edition = process.argv.includes("--ngr-edition=test") ? "test" : "dev";
void runDesktopApp({ edition }).catch(reportStartupFailure);
