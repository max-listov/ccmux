import { expect, test } from 'bun:test';
import { ownedChildAlive, stopOwnedChildGroup } from '../src/agent/codex/ownedChild.ts';

test('provider group disposal reaps the real writer after its launcher dies with inherited pipes open', async () => {
  const script = `const child = Bun.spawn([process.execPath,"--eval","setInterval(()=>{},1000)"],{stdout:"inherit",stderr:"inherit"});console.log(child.pid);setInterval(()=>{},1000)`;
  const wrapper = Bun.spawn([process.execPath, '--eval', script], {
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = wrapper.stdout.getReader();
  let nativePid: number | null = null;
  try {
    const line = await reader.read();
    nativePid = Number(
      Buffer.from(line.value ?? [])
        .toString()
        .trim(),
    );
    expect(nativePid).toBeGreaterThan(0);
    expect(ownedChildAlive(nativePid)).toBe(true);
    process.kill(wrapper.pid, 'SIGKILL');
    const deadline = Date.now() + 1000;
    while (ownedChildAlive(wrapper.pid) && Date.now() < deadline) await Bun.sleep(5);
    expect(ownedChildAlive(wrapper.pid)).toBe(false);
    expect(ownedChildAlive(nativePid)).toBe(true);
    await stopOwnedChildGroup(wrapper);
    const childDeadline = Date.now() + 1000;
    while (ownedChildAlive(nativePid) && Date.now() < childDeadline) await Bun.sleep(5);
    expect(ownedChildAlive(nativePid)).toBe(false);
  } finally {
    await stopOwnedChildGroup(wrapper);
    await reader.cancel();
  }
});
