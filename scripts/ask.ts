/**
 * Interactive "talk to your brain" REPL — type your OWN questions; teach it your OWN knowledge.
 * A dev/demo tool over the same answerQuestion()/writeMemory() the tests use — NOT part of the engine.
 * Knowledge lives in an in-process pglite DB for THIS SESSION ONLY (nothing persists between runs).
 *
 * Run (it loads .env itself, so no flags needed):   pnpm ask
 * Needs OPENAI_API_KEY + ANTHROPIC_API_KEY in .env (real embeddings + real Claude). Each question is a few
 * cents of API. REAL mode only — arbitrary questions need real semantics, not the offline stub.
 *
 * Commands:
 *   <just type a question>     ask your brain — get a sourced "I know this" or an honest "I don't know"
 *   /add <text>                teach it a fact (a 'semantic' memory)
 *   /addfile <path>            teach it the contents of a file
 *   /help                      show commands
 *   /quit                      exit
 */
import { createInterface } from 'node:readline/promises';
import { readFileSync, existsSync } from 'node:fs';

// Self-load .env so `pnpm ask` just works (the engine never auto-loads .env; this is a dev convenience).
function loadEnv(): void {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

import { freshDb } from '../tests/core/helpers/pglite.ts';
import { writeMemory, ingestSop, type QueryFn } from '../packages/core/src/memory/store.ts';
import { answerQuestion } from '../packages/core/src/harness/synthesis.ts';
import { renderAnswer } from '../packages/core/src/harness/provenance.ts';

const HELP = `
  <type a question>     ask your brain
  /add <text>           teach it a fact
  /addfile <path>       teach it a file's contents
  /help                 show this
  /quit                 exit
`;

/** Teach the brain an arbitrary fact (a high-trust semantic memory). */
async function teach(query: QueryFn, text: string, sourceRef: string): Promise<void> {
  await writeMemory(query, {
    type: 'semantic',
    namespace: 'org',
    zone: 'general',
    sensitivityLevel: 1,
    statement: text,
    provenance: { sourceRefs: [sourceRef], capturedAt: new Date().toISOString(), trustLevel: 'high' },
  });
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error('Need OPENAI_API_KEY + ANTHROPIC_API_KEY in .env (real embeddings + Claude). Add them and re-run `pnpm ask`.');
    process.exit(1);
  }

  const { query } = await freshDb();
  const deps = { query }; // REAL mode: gateway embeddings + Claude synthesis

  // Seed a couple of starter facts so it isn't empty — replace these by teaching your own with /add.
  await ingestSop(query, {
    namespace: 'org',
    statement: 'To onboard a new client: create the workspace, invite the client team, book the kickoff within 5 business days, send the welcome pack.',
    sourceRef: 'upload://sop/onboarding.pdf',
    capturedAt: '2026-02-01T00:00:00.000Z',
  });
  await teach(query, 'Acme prefers monthly reporting, delivered async — no status calls.', 'note://acme/prefs');

  console.log('\n🧠 Your brain is ready (REAL mode). It knows a couple of starter facts.');
  console.log('   Ask it anything, or teach it with /add. /help for commands, /quit to exit.\n');

  // for-await over the interface ends cleanly on EOF (Ctrl-D or piped input) AND on /quit (break) —
  // no ERR_USE_AFTER_CLOSE. rl.prompt() re-shows '›' after each handled line.
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '/quit' || line === '/exit') break;
    if (!line) { rl.prompt(); continue; }
    if (line === '/help') { console.log(HELP); rl.prompt(); continue; }
    if (line.startsWith('/add ')) {
      await teach(query, line.slice(5).trim(), `note://you/${process.hrtime.bigint()}`);
      console.log('  ✓ learned.\n');
      rl.prompt();
      continue;
    }
    if (line.startsWith('/addfile ')) {
      const path = line.slice(9).trim();
      try {
        await teach(query, readFileSync(path, 'utf8'), `file://${path}`);
        console.log(`  ✓ learned ${path}\n`);
      } catch (e) {
        console.log(`  ✗ ${(e as Error).message}\n`);
      }
      rl.prompt();
      continue;
    }
    // Otherwise: it's a question.
    try {
      const { answer, retrieval } = await answerQuestion(line, deps);
      console.log('\n' + renderAnswer(answer, retrieval) + '\n');
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}\n`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((err) => {
  console.error('[ask] failed:', err);
  process.exit(1);
});
