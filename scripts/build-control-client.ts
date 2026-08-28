import { join } from "node:path";

/** Self-contained resident client; imports do not start a server or provider. */
export async function buildControlClient(directory: string): Promise<void> {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/control-client.ts")], target: "bun" });
  const [artifact] = result.outputs;
  if (!result.success || !artifact) throw new Error(`Control client build failed: ${result.logs.join("\n")}`);
  const bytes = await artifact.arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(directory, "control-client.js"), bytes);
  await Bun.write(join(directory, "control-client.sha256"), `${hash}  control-client.js\n`);
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error("usage: bun scripts/build-control-client.ts <output-directory>");
  await buildControlClient(directory);
}
