import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceBundle } from "../src/commands/update.ts";
import { shimContents } from "../src/config/migrateBundle.ts";
import {
  ControlNativeStreamFrameSchema,
  controlNativeStreamFrame,
  createCcmuxNativeStreamProfile,
} from "../src/control/nativeStreamContract.ts";
import { makePeer } from "./helpers.ts";

function bundle(path: string, sequence: number): void {
  const snapshot = {
    target: makePeer({ agent: "codex", session: "agent-a" }),
    generation: "22222222-2222-4222-8222-222222222222",
    sequence,
    reset: "initial",
    observedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-08-29T00:01:00.000Z",
    pending: [],
    items: [],
  };
  const line = JSON.stringify(controlNativeStreamFrame(snapshot));
  writeFileSync(path, `#!/bin/sh\nread request\nprintf '%s\\n' '${line}'\n`);
  chmodSync(path, 0o700);
}

async function firstFrame(executable: string) {
  const profile = createCcmuxNativeStreamProfile(executable);
  const child = Bun.spawn([profile.bin, ...profile.argv], {
    env: profile.env.set,
    stdin: new TextEncoder().encode(JSON.stringify({ target: makePeer({ agent: "codex", session: "agent-a" }), cursor: null })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  return ControlNativeStreamFrameSchema.parse(JSON.parse(stdout.trim()));
}

test("standard installed executable runs the native profile with an empty environment across upgrade and rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-installed-profile-"));
  const app = join(root, "app", "ccmux.js");
  const runtime = join(root, "bun");
  const executable = join(root, "bin", "ccmux");
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(runtime, "#!/bin/sh\nexec /bin/sh \"$@\"\n");
  chmodSync(runtime, 0o700);
  bundle(app, 1);
  writeFileSync(executable, `#!/bin/sh\nexec "${runtime}" "${app}" "$@"\n`);
  chmodSync(executable, 0o700);
  try {
    const installed = await firstFrame(executable);
    expect(JSON.parse(installed.data).sequence).toBe(1);

    const candidate = join(root, "candidate");
    bundle(candidate, 2);
    await replaceBundle(candidate, app, true);
    expect(JSON.parse((await firstFrame(executable)).data).sequence).toBe(2);

    copyFileSync(`${app}.bak`, app);
    expect(JSON.parse((await firstFrame(executable)).data).sequence).toBe(1);
    expect(readFileSync(executable, "utf8")).toStartWith("#!/bin/sh\n");
    expect(shimContents()).toStartWith("#!/bin/sh\n");
    expect(createCcmuxNativeStreamProfile(executable).env).toEqual({ inherit: [], set: {} });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
