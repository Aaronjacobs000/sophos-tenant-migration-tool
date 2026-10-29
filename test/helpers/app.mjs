// Boots the compiled backend state against the fake Sophos in a temp repo
// root, so services run exactly as they do in the app.

import { after } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SRC, DST } from "./fake-sophos.mjs";

export async function bootApp(fake) {
  globalThis.fetch = fake.fetch;
  // The logger prints every line; keep test output readable.
  for (const k of ["log", "warn", "error"]) console[k] = () => {};

  const root = await mkdtemp(path.join(tmpdir(), "stmt-test-"));
  // Removed once the file's tests have run, so runs don't pile up temp folders.
  after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  // Job credentials are encrypted with a key kept outside the repo; keep the tests' key in the temp root.
  process.env.JOB_CREDENTIALS_KEY_FILE = path.join(root, "key", "job-credentials.key");
  await writeFile(
    path.join(root, ".env"),
    [
      "CREDENTIAL_MODE=direct",
      `SOPHOS_SOURCE_CLIENT_ID=${SRC.clientId}`,
      `SOPHOS_SOURCE_CLIENT_SECRET=${SRC.secret}`,
      "SOPHOS_SOURCE_LABEL=Test Source",
      `SOPHOS_DEST_CLIENT_ID=${DST.clientId}`,
      `SOPHOS_DEST_CLIENT_SECRET=${DST.secret}`,
      "SOPHOS_DEST_LABEL=Test Destination",
      "",
    ].join("\n"),
  );
  const state = await import("../../backend/dist/state.js");
  await state.initState(root);
  // initState starts the background preload; let it settle so its GETs do
  // not interleave with the calls a test asserts on.
  const preloader = await import("../../backend/dist/services/preloader.js");
  for (let i = 0; i < 200; i++) {
    const st = preloader.getPreloadStatus();
    const busy = ["source", "dest"].some((side) => Object.values(st[side]).some((x) => x.state === "loading"));
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  fake.reset();
  return { root, state };
}

export async function readAudit(root) {
  try {
    const raw = await readFile(path.join(root, "data", "audit.log"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
