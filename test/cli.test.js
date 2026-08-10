import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EXIT_CODES,
  parseArgs,
  runCli,
} from '../src/cli.js';

function capture() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
    },
    out,
    err,
  };
}

test('help is clear and exits successfully', async () => {
  const stream = capture();
  const result = await runCli(['--help'], { io: stream.io });

  assert.equal(result.code, EXIT_CODES.OK);
  assert.match(stream.out.join('\n'), /worktree-proof/);
  assert.match(stream.out.join('\n'), /doctor/);
  assert.equal(stream.err.length, 0);
});

test('version is available as a command and an option', async () => {
  const command = capture();
  const option = capture();
  const first = await runCli(['version'], { io: command.io });
  const second = await runCli(['--version'], { io: option.io });

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.match(command.out[0], /^worktree-proof \d+\.\d+\.\d+$/);
  assert.equal(command.out[0], option.out[0]);
});

test('unknown options fail deterministically', async () => {
  const stream = capture();
  const result = await runCli(['status', '--not-a-real-option'], { io: stream.io });

  assert.equal(result.code, EXIT_CODES.USAGE);
  assert.match(stream.err[0], /unknown option/);
});

test('parser preserves argv only after the run separator', () => {
  const parsed = parseArgs(['run', '--repo', '.', '--', 'node', '-e', 'console.log(1)']);

  assert.equal(parsed.command, 'run');
  assert.deepEqual(parsed.passthrough, ['node', '-e', 'console.log(1)']);
  assert.equal(parsed.options.repo, '.');
});

test('run passes an argv array and never a shell string', async () => {
  const stream = capture();
  let received;
  const result = await runCli(
    ['run', '--', 'node', '--version'],
    {
      io: stream.io,
      deps: {
        runner: {
          executeArgv: async (payload) => {
            received = payload;
            return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0 };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(received, ['node', '--version']);
  assert.ok(Array.isArray(received));
  assert.equal(typeof received, 'object');
});

test('dry-run reserve does not invoke the lease adapter', async () => {
  const stream = capture();
  let called = false;
  const result = await runCli(
    ['reserve', '--lane-id', 'docs-api', '--dry-run'],
    {
      io: stream.io,
      deps: {
        leases: {
          reserveLease: async () => {
            called = true;
            return { leaseId: 'should-not-exist' };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(called, false);
  assert.match(stream.out[0], /planned/);
});

test('no-submi×]z¶‰žËkºwµçM•¹ÕÍ•Ì‰½Õ¹‘•ÍÑÉÕÑÕÉ•™¥•±‘Ìœ°…Íå¹Œ€ ¤€ôøì(€±•Ð…±±Ì€ô€Àì(€½¹ÍÐ‰É¥‘”€ôì(€€€Í•¹‘	É¥‘•5•ÍÍ…”è…Íå¹Œ€¡}É½½Ð°µ•ÍÍ…”¤€ôøì(€€€€€…±±Ì€¬ô€Äì(€€€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡µ•ÍÍ…”¹Í•¹‘•È°€½‘•àœ¤ì(€€€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡µ•ÍÍ…”¹É•¥Á¥•¹Ð°€±…Õ‘”œ¤ì(€€€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡µ•ÍÍ…”¹™¥±•M½Á”°€‘½Ì¼œ¤ì(€€€€€…ÍÍ•ÉÐ¹‘••ÁÅÕ…°¡µ•ÍÍ…”¹…Á…‰¥±¥Ñ¥•Ì°lÑ•ÍÐœ°€¥¹ÍÁ•Ðt¤ì(€€€€€É•ÑÕÉ¸ìµ•ÍÍ…•%è€µ•ÍÍ…”´Äœ°€¸¸¹µ•ÍÍ…”°ÍÑ…ÑÕÌè€Á•¹‘¥¹œœôì(€€€ô°(€ôì(€½¹ÍÐÁÉ•Ù¥•ÝMÑÉ•…´€ô…ÁÑÕÉ” ¤ì(€½¹ÍÐÁÉ•Ù¥•Ü€ô…Ý…¥ÐÉÕ¹±¤¡l(€€€€‰É¥‘”œ°€Í•¹œ°€œ´µÍ•¹‘•Èœ°€½‘•àœ°€œ´µÉ•¥Á¥•¹Ðœ°€±…Õ‘”œ°€œ´µÑåÁ”œ°€Ñ…Í¬œ°(€€€€œ´µÍÕµµ…Éäœ°€I•Ù¥•Ü‘½Ìœ°€œ´µÍ½Á”œ°€‘½Ì¼œ°€œ´µ‘ÉäµÉÕ¸œ°(€t°ì¥¼èÁÉ•Ù¥•ÝMÑÉ•…´¹¥¼°‘•ÁÌèì‰É¥‘”ôô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡ÁÉ•Ù¥•Ü¹½‘”°a%Q}=L¹=,¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡…±±Ì°€À¤ì((€½¹ÍÐÍÑÉ•…´€ô…ÁÑÕÉ” ¤ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÉÕ¹±¤¡l(€€€€‰É¥‘”œ°€Í•¹œ°€œ´µÍ•¹‘•Èœ°€½‘•àœ°€œ´µÉ•¥Á¥•¹Ðœ°€±…Õ‘”œ°€œ´µÑåÁ”œ°€Ñ…Í¬œ°(€€€€œ´µÍÕµµ…Éäœ°€I•Ù¥•Ü‘½Ìœ°€œ´µÍ½Á”œ°€‘½Ì¼œ°€œ´µ…Á…‰¥±¥Ñ¥•Ìœ°€Ñ•ÍÐ±¥¹ÍÁ•Ðœ°€œ´µ©Í½¸œ°(€t°ì¥¼èÍÑÉ•…´¹¥¼°‘•ÁÌèì‰É¥‘”ôô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡É•ÍÕ±Ð¹½‘”°a%Q}=L¹=,¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡…±±Ì°€Ä¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡)M=8¹Á…ÉÍ”¡ÍÑÉ•…´¹½ÕÑlÁt¤¹É•ÍÕ±Ð¹µ•ÍÍ…”¹µ•ÍÍ…•%°€µ•ÍÍ…”´Äœ¤ì)ô¤ì()Ñ•ÍÐ ‰É¥‘”¥¹‰½à¥ÌÉ•…µ½¹±ä…¹‰É¥‘”ÍÑ…Ñ”…¹¹½Ð•Í…Á”Ñ¡”É•Á½Í¥Ñ½Éäœ°…Íå¹Œ€ ¤€ôøì(€½¹ÍÐÍÑÉ•…´€ô…ÁÑÕÉ” ¤ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÉÕ¹±¤¡l‰É¥‘”œ°€¥¹‰½àœ°€œ´µ…•¹Ðœ°€±…Õ‘”œ°€œ´µ©Í½¸t°ì(€€€¥¼èÍÑÉ•…´¹¥¼°(€€€‘•ÁÌèì‰É¥‘”èì±¥ÍÑ	É¥‘•%¹‰½àè…Íå¹Œ€¡}É½½Ð°½ÁÑ¥½¹Ì¤€ôømìÉ•¥Á¥•¹Ðè½ÁÑ¥½¹Ì¹É•¥Á¥•¹Ð°ÍÑ…ÑÕÌè€Á•¹‘¥¹œœõtôô°(€ô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡É•ÍÕ±Ð¹½‘”°a%Q}=L¹=,¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡)M=8¹Á…ÉÍ”¡ÍÑÉ•…´¹½ÕÑlÁt¤¹É•ÍÕ±Ð¹µ•ÍÍ…•ÍlÁt¹É•¥Á¥•¹Ð°€±…Õ‘”œ¤ì((€½¹ÍÐ•Í…Á”€ô…ÁÑÕÉ” ¤ì(€½¹ÍÐ•Í…Á•€ô…Ý…¥ÐÉÕ¹±¤¡l‰É¥‘”œ°€¥¹‰½àœ°€œ´µ…•¹Ðœ°€±…Õ‘”œ°€œ´µ‰É¥‘”µÉ½½Ðœ°€œ¸¹qq½ÕÑÍ¥‘”t°ì(€€€¥¼è•Í…Á”¹¥¼°(€€€‘•ÁÌèì‰É¥‘”èì±¥ÍÑ	É¥‘•%¹‰½àè…Íå¹Œ€ ¤€ôømtôô°(€ô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡•Í…Á•¹½‘”°a%Q}=L¹UM¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡•Í…Á”¹•ÉÉlÁt°€½¥¹Í¥‘”Ñ¡”É•Á½Í¥Ñ½Éä¼¤ì)ô¤ì()Ñ•ÍÐ Ñ…Í­Ì¥¹ÍÁ•Ð…•ÁÑÌ½¹±ä…¸•áÁ±¥¥ÐÍ¹…ÁÍ¡½Ð…¹É•ÑÕÉ¹ÌÍ…¹¥Ñ¥é•µ•Ñ…‘…Ñ„œ°…Íå¹Œ€ ¤€ôøì(€½¹ÍÐÉ½½Ð€ô…Ý…¥Ðµ­‘Ñ•µÀ¡Á…Ñ ¹©½¥¸¡½Ì¹ÑµÁ‘¥È ¤°€Ý½É­ÑÉ•”µÁÉ½½˜µ±¤µÑ…Í­Ì´œ¤¤ì(€ÑÉäì(€€€…Ý…¥ÐÝÉ¥Ñ•¥±”¡Á…Ñ ¹©½¥¸¡É½½Ð°€Ñ…Í­Ì¹©Í½¸œ¤°)M=8¹ÍÑÉ¥¹¥™ä¡ìÑ…Í­Ìèmì¥è€ÁÉ¥Ù…Ñ”µ¥œ°ÍÑ…ÑÕÌè€…Ñ¥Ù”œõtô¤¤ì(€€€½¹ÍÐÍÑÉ•…´€ô…ÁÑÕÉ” ¤ì(€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÉÕ¹±¤¡lÑ…Í­Ìœ°€¥¹ÍÁ•Ðœ°€œ´µ¥¹ÁÕÐœ°€Ñ…Í­Ì¹©Í½¸œ°€œ´µ©Í½¸t°ì(€€€€€¥¼èÍÑÉ•…´¹¥¼°(€€€€€É•Á¼èÉ½½Ð°(€€€€€‘•ÁÌèì(€€€€€€€Ñ…Í­Ìèì(€€€€€€€€€Í…¹¥Ñ¥é•Q…Í­M¹…ÁÍ¡½Ðè€ ¤€ôø€¡ìÑ…Í­ÌèmìÑ…Í­%è€…‰‘•˜ÀÄÈÌÐÔØÜàäœ°ÍÑ…ÑÕÌè€…Ñ¥Ù”œ°É•Á½ÉÑ•‘5½‘”è€Õ¹­¹½Ý¸œõtô¤°(€€€€€€€ô°(€€€€€ô°(€€€ô¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡É•ÍÕ±Ð¹½‘”°a%Q}=L¹=,¤ì(€€€½¹ÍÐ½ÕÑÁÕÐ€ô)M=8¹Á…ÉÍ”¡ÍÑÉ•…´¹½ÕÑlÁt¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡½ÕÑÁÕÐ¹É•ÍÕ±Ð¹Í¹…ÁÍ¡½Ð¹Ñ…Í­ÍlÁt¹É•Á½ÉÑ•‘5½‘”°€Õ¹­¹½Ý¸œ¤ì(€€€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡ÍÑÉ•…´¹½ÕÑlÁt°€½ÁÉ¥Ù…Ñ”µ¥¼¤ì(€ô™¥¹…±±äì(€€€…Ý…¥ÐÉ´¡É½½Ð°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”°™½É”èÑÉÕ”ô¤ì(€ô)ô¤ì