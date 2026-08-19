import { reportStartupFailure, runDesktopApp } from "./bootstrap.mjs";

void runDesktopApp({ edition: "test" }).catch(reportStartupFailure);
