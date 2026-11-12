import { z } from 'zod';
import { type RemoteTransport, remoteTransportAncestor } from '../chat/auth.ts';
import {
  COMMUNICATION_AUTHORIZATION_HELP,
  readCommunicationAuthorization,
} from '../chat/communicationAuthorization.ts';
import type { CommunicationAuthorizationInput } from '../chat/communicationAuthorizationSchema.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { senderFor } from '../chat/letterParties.ts';
import { LetterRequestSchema } from '../chat/letterRequestSchema.ts';
import { type LetterOutcome, sendLetter } from '../chat/sendLetter.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { loadSessions } from '../session/registry.ts';
import { printLine } from '../util/stdout.ts';
import { COMMAND_SCHEMAS } from './answerSchemas.ts';
import { parseFlags } from './flags.ts';
import { usageLine } from './help.ts';
import { msgCancel } from './msgCancel.ts';
import { msgPending } from './msgPending.ts';
import { msgSent } from './msgSent.ts';

/**
 * Say what became of a letter — once, in the form that was asked for.
 *
 * A person is told in sentences; a program asked for `--json` and gets exactly one line, the
 * letter's receipt, with whatever the sentences added carried as its note. A sentence beside the
 * answer goes to stderr there, where it does not become part of it.
 */
async function report(outcome: LetterOutcome, asJson: boolean): Promise<number> {
  if (outcome.status === 'refused') {
    console.error(outcome.reason);
    return 1;
  }
  for (const line of outcome.aside) (asJson ? console.error : console.log)(line);
  if (asJson) await printLine(JSON.stringify(outcome.receipt));
  else {
    for (const line of outcome.told) console.log(line);
    // `thread-continuation` asks for a reference to the sender's OWN accepted letter, which the
    // sender was never shown: printed here, it is copied rather than composed. Only an accepted
    // letter is named — one held for retry is not yet in the recipient's ledger.
    if (outcome.continuation !== null)
      console.log(
        `letter ${outcome.continuation} — sourceMessageRef of a thread-continuation to this recipient under the same --task`,
      );
  }
  for (const line of outcome.remarks) console.error(line);
  return outcome.exitCode;
}

export async function cmdMsg(args: string[], transport?: RemoteTransport | null): Promise<number> {
  const flags = parseFlags('msg', args);
  const positionals = flags.positionals;
  const asJson = flags.bool('json');
  const toAgent = flags.str('to-agent');
  if (toAgent !== undefined && !AgentKindSchema.safeParse(toAgent).success) {
    console.error('msg: --to-agent needs a supported runtime');
    return 1;
  }
  const toThread = flags.str('to-thread');
  if (toThread !== undefined && !z.uuid().safeParse(toThread).success) {
    console.error('msg: --to-thread needs a UUID');
    return 1;
  }
  let communicationAuthorization: CommunicationAuthorizationInput | undefined;
  const authorizationPath = flags.str('communication-authorization');
  if (authorizationPath !== undefined) {
    try {
      communicationAuthorization = await readCommunicationAuthorization(authorizationPath);
    } catch {
      console.error(
        `msg: invalid communication authorization file. ${COMMUNICATION_AUTHORIZATION_HELP}`,
      );
      return 1;
    }
  }

  if (flags.bool('schema')) {
    await printLine(JSON.stringify(COMMAND_SCHEMAS.msg()));
    return 0;
  }
  if (asJson && (positionals[0] === 'pending' || positionals[0] === 'cancel')) {
    console.error(`msg: --json answers a send and 'sent', not '${positionals[0]}'`);
    return 1;
  }
  const machine = loadMachineConfig();
  const from = await senderFor(machine.rcPrefix, loadSessions(machine), machine);
  if ('error' in from) {
    console.error(from.error);
    return 1;
  }

  if (positionals[0] === 'pending') return msgPending(machine, from, positionals[1]);
  if (positionals[0] === 'sent') return msgSent(machine, from, positionals[1], asJson);
  if (positionals[0] === 'cancel') return msgCancel(machine, from, positionals[1]);

  const to = positionals[0];
  let body = positionals.slice(1).join(' ').trim();
  if (body === '' && to !== undefined && !process.stdin.isTTY)
    body = (await Bun.stdin.text()).trim();
  if (!to || body === '') {
    console.error(usageLine('msg'));
    return 1;
  }
  const request = LetterRequestSchema.parse({
    to,
    body,
    task: flags.str('task') ?? null,
    interrupt: flags.bool('interrupt'),
    onBehalfOf: flags.str('on-behalf-of') ?? null,
    afterSeconds: flags.int('after') ?? null,
    toAgent: toAgent ?? null,
    toThread: toThread ?? null,
    ...(communicationAuthorization === undefined ? {} : { communicationAuthorization }),
  });
  const senderTransport =
    transport === undefined
      ? from.kind === 'cli'
        ? remoteTransportAncestor(machine)
        : null
      : transport;
  return report(await sendLetter(machine, from, request, { senderTransport }), asJson);
}
