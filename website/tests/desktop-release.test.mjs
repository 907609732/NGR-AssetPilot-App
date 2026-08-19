import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopRelease } from "../lib/desktop-release.mjs";

const validEnvironment = Object.freeze({
  NGR_RELEASE_EXE_URL:
    "https://github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.0/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe",
  NGR_RELEASE_VERSION: "3.0.0",
  NGR_RELEASE_SHA256: "A".repeat(64),
  NGR_RELEASE_VERIFIED: "1",
  NGR_RELEASE_CREDENTIAL_SCAN_PASSED: "1",
});

test("empty configuration keeps the public download disabled", () => {
  assert.equal(parseDesktopRelease({}), null);
});

test("a reviewed HTTPS EXE release passes the public download gate", () => {
  const release = parseDesktopRelease(validEnvironment);

  assert.deepEqual(release, {
    url: validEnvironment.NGR_RELEASE_EXE_URL,
    version: "3.0.0",
    filename: "NGR-AssetPilot-Test-3.0.0-Setup-x64.exe",
    sha256: "a".repeat(64),
    credentialScanPassed: true,
  });
});

test("the gate rejects an unverified or credential-bearing public package", () => {
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_VERIFIED: "0" }),
    /RELEASE_VERIFIED=1/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_CREDENTIAL_SCAN_PASSED: "0" }),
    /CREDENTIAL_SCAN_PASSED=1/,
  );
});

test("the gate rejects unsafe, indirect, or mismatched download URLs", () => {
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "http://github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.0/file-3.0.0.exe" }),
    /HTTPS/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/907609732/NGR-AssetPilot-App/releases" }),
    /\.exe/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://user:secret@github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.0/file-3.0.0.exe" }),
    /用户名或密码/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.0/file-3.0.1.exe" }),
    /文件名必须包含版本号/,
  );
});

test("the gate only accepts the official GitHub repository release path", () => {
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://downloads.example.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.0/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe" }),
    /只允许 github\.com/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/another-owner/NGR-AssetPilot-App/releases/download/v3.0.0/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe" }),
    /907609732\/NGR-AssetPilot-App/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/907609732/another-repo/releases/download/v3.0.0/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe" }),
    /907609732\/NGR-AssetPilot-App/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/907609732/NGR-AssetPilot-App/raw/main/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe" }),
    /releases\/download/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_EXE_URL: "https://github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.1/NGR-AssetPilot-Test-3.0.0-Setup-x64.exe" }),
    /Release 标签必须是 v3\.0\.0/,
  );
});

test("a partial release configuration fails closed", () => {
  assert.throws(
    () => parseDesktopRelease({ NGR_RELEASE_EXE_URL: validEnvironment.NGR_RELEASE_EXE_URL }),
    /NGR_RELEASE_VERSION/,
  );
  assert.throws(
    () => parseDesktopRelease({ ...validEnvironment, NGR_RELEASE_SHA256: "not-a-hash" }),
    /64 位十六进制/,
  );
});
