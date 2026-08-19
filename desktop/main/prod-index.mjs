import { reportStartupFailure, runDesktopApp } from "./bootstrap.mjs";

void runDesktopApp({ edition: "prod" }).catch(reportStartupFailure);
