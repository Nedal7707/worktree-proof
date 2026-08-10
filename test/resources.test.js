import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import {
  chooseResourceProfile,
  DEFAULT_REQUESTED_CONCURRENCY,
  MAX_REQUESTED_CONCURRENCY,
  planProjectCleanup,
  planSessionGuard,
  PUBLIC_MAX_CONCURRENCY,
  recommendConcurrency,
  scanResources,
  summarizeResources,
} from '../src/resources.js';

const bytes = (gib) => gib * 1024 ** 3;

function mockedOs({ platform = 'linux', logicalCount = 4, load = [0.5, 0.4, 0.3], total = bytes(8), free = bytes(4) } = {}) {
  return {
    platform,
    cpus: () => Array.from({ length: logicalCount }, () => ({})),
    loadavg: () => load,
    totalmem: () => total,
    freemem: () => free,
  };
}

async function makeFixture() {
  const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'worktree-proof-resource-'));
  await mkdir(nodePath.join(root, '.cache'), { recursive: true });
  await mkdir(nodePath.join(root, 'build'), { recursive: true });
  await mkdir(nodePath.join(root, '.git', 'worktrees'), { recursive: true });
  await writeFile(nodePath.join(root, 'README.txt'), 'fixture');
  await writeFile(nodePath.join(root, '.cache', 'cache.bin'), 'cache');
  await writeFile(nodePath.join(root, 'build', 'artifact.bin'), 'artifact');
  return root;
}

test('scans mocked Linux metrics and reports bounded footprint categories', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs(),
      nodeMemory: { rss: bytes(1), heapTotal: 1000, heapUsed: 500, external: 20 },
      disk: { totalBytes: bytes(100), freeBytes: bytes(80) },
      concurrency: 2,
      maxDepth: 5,
      maxEntries: 100,
      now: '2026-08-10T00:00:00.000Z',
    });
    assert.equal(scan.platform, 'linux');
    assert.equal(scan.cpu.logicalCount, 4);
    assert.equal(scan.cpu.load, 0.5);
    assert.equal(scan.memory.totalBytes, bytes(8));
    assert.equal(scan.memory.pressureRatio, 0.5);
    assert.equal(scan.node.heapPressureRatio, 0.5);
    assert.equal(scan.disk.freeBytes, bytes(80));
    assert.equal(scan.concurrency.current, 2);
    assert.equal(scan.footprint.status, 'ok');
    assert.ok(scan.footprint.cache.bytes >= Buffer.byteLength('cache'));
    assert.ok(scan.footprint.build.bytes >= Buffer.byteLength('artifact'));
    assert.match(summarizeResources(scan), /CPU 4 logical/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mocked Windows low RAM and disk select low-resource and constrain workers', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs({ platform: 'win32', logicalCount: 16, load: [0.1, 0.1, 0.1], total: bytes(4), free: bytes(0.25) }),
      disk: { totalBytes: bytes(1), freeBytes: bytes(0.05) },
      nodeMemory: { heapTotal: 100, heapUsed: 10 },
×7¶‰žËkºwµçt¹…Ñ•½Éä€ôôô€…¡”œ¤¤ì(€€€…ÍÍ•ÉÐ¹½¬¡Á±…¸¹¥Ñ•µÌ¹•Ù•Éä ¡¥Ñ•´¤€ôø¥Ñ•´¹Í…™•Q½•±•Ñ”€ôôô™…±Í”€˜˜¥Ñ•´¹É•ÅÕ¥É•Í½¹™¥Éµ…Ñ¥½¸€ôôôÑÉÕ”¤¤ì(€€€…ÍÍ•ÉÐ¹•ÅÕ…°¡…Ý…¥ÐÉ•…‘¥±”¡¹½‘•A…Ñ ¹©½¥¸¡É½½Ð°€I5¹ÑáÐœ¤°€ÕÑ˜àœ¤°‰•™½É”¤ì(€€€…Ý…¥Ð…ÍÍ•ÉÐ¹É•©•ÑÌ  ¤€ôøAÉ½µ¥Í”¹É•Í½±Ù”¡Á±…¹AÉ½©•Ñ±•…¹ÕÀ¡Í…¸°ì…±±½Ý•‘I½½ÑÌèlœ¸¹qq½ÕÑÍ¥‘”tô¤¤¹Ñ¡•¸ ¡É•ÍÕ±Ð¤€ôøÉ•ÍÕ±Ð¹‰±½­•€üAÉ½µ¥Í”¹É•©•Ð¡¹•ÜÉÉ½È ‰±½­•œ¤¤€èÉ•ÍÕ±Ð¤°€½‰±½­•¼¤ì(€€€…Ý…¥ÐÍÑ…Ð¡É½½Ð¤ì(€ô™¥¹…±±äì(€€€…Ý…¥ÐÉ´¡É½½Ð°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”°™½É”èÑÉÕ”ô¤ì(€ô)ô¤ì()Ñ•ÍÐ Í•ÍÍ¥½¸Õ…É­••ÁÌÑ¡”ÁÕ‰±¥Œ‘•™…Õ±Ð…Ð€àÝ¡¥±”¡½ÍÐ…¹É•Í½ÕÉ”•¥±¥¹ÌÍÑ…ä…ÕÑ¡½É¥Ñ…Ñ¥Ù”œ°€ ¤€ôøì(€½¹ÍÐÕ…É€ôÁ±…¹M•ÍÍ¥½¹Õ…É¡ì(€€€ÁÔèì±½¥…±½Õ¹Ðè€ÌÈ°¹½Éµ…±¥é•‘1½…è€À¸Äô°(€€€µ•µ½Éäèì™É••	åÑ•Ìè‰åÑ•Ì ØÐ¤°ÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Èô°(€€€‘¥Í¬èìÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Äô°(€€€½¹ÕÉÉ•¹äèìÕÉÉ•¹Ðè€Àô°(€ô°ìÁÉ½™¥±”è€™…ÍÐœ°­¥¹è€¥¼œ°¡½ÍÑ•¥±¥¹œè€ÈÐô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹Á…É•¹Ñ½Õ¹Ð°€Ä¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹µÕÑ…Ñ¥¹œ°™…±Í”¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹É•ÅÕ•ÍÑ•‘Q…É•Ð°U1Q}IEUMQ}=9UII9d¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹½¹™¥ÕÉ•‘I•ÅÕ•ÍÑ5…á¥µÕ´°5a}IEUMQ}=9UII9d¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹Í…™•…Á…¥Ñä°€à¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹…•ÁÑ9•Ý1…¹•Ì°ÑÉÕ”¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹ÅÕ•Õ”°€‰½Õ¹‘•µ‰…­ÁÉ•ÍÍÕÉ”œ¤ì)ô¤ì()Ñ•ÍÐ „‘•±¥‰•É…Ñ”Á•ÈµÕÍ•È½ÁÐµ¥¸…¸É•ÅÕ•ÍÐ€ÈÀÝ¥Ñ¡½ÕÐ¡…¹¥¹œÑ¡”‘•™…Õ±Ðœ°€ ¤€ôøì(€½¹ÍÐÕ…É€ôÁ±…¹M•ÍÍ¥½¹Õ…É¡ì(€€€ÁÔèì±½¥…±½Õ¹Ðè€ÌÈ°¹½Éµ…±¥é•‘1½…è€À¸Äô°(€€€µ•µ½Éäèì™É••	åÑ•Ìè‰åÑ•Ì ØÐ¤°ÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Èô°(€€€‘¥Í¬èìÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Äô°(€€€½¹ÕÉÉ•¹äèìÕÉÉ•¹Ðè€Àô°(€ô°ìÁÉ½™¥±”è€™…ÍÐœ°­¥¹è€¥¼œ°É•ÅÕ•ÍÑ•è€ÈÀ°¡½ÍÑ•¥±¥¹œè€ÈÐô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡U1Q}IEUMQ}=9UII9d°€à¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹É•ÅÕ•ÍÑ•‘9•Ý1…¹•Ì°€ÈÀ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹Í…™•…Á…¥Ñä°€ÈÀ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹…•ÁÑ9•Ý1…¹•Ì°ÑÉÕ”¤ì)ô¤ì()Ñ•ÍÐ É•ÅÕ•ÍÑ•€ÈÐ¥Ì…ÁÁ•‰ä¡½ÍÐ€ÄØ…¹½Ñ¡•ÈÑ…Í¬É•Í•ÉÙ…Ñ¥½¹Ìœ°€ ¤€ôøì(€½¹ÍÐÍ…¸€ôì(€€€ÁÔèì±½¥…±½Õ¹Ðè€ÌÈ°¹½Éµ…±¥é•‘1½…è€À¸Äô°(€€€µ•µ½Éäèì™É••	åÑ•Ìè‰åÑ•Ì ØÐ¤°ÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Èô°(€€€‘¥Í¬èìÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Äô°(€€€½¹ÕÉÉ•¹äèìÕÉÉ•¹Ðè€Àô°(€ôì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡É•½µµ•¹‘½¹ÕÉÉ•¹ä¡Í…¸°ìÁÉ½™¥±”è€™…ÍÐœ°­¥¹è€¥¼œ°É•ÅÕ•ÍÑ•è€ÈÐ°¡½ÍÑ•¥±¥¹œè€ÄØô¤°€ÄØ¤ì(€½¹ÍÐÕ…É€ôÁ±…¹M•ÍÍ¥½¹Õ…É¡Í…¸°ì(€€€ÁÉ½™¥±”è€™…ÍÐœ°(€€€­¥¹è€¥¼œ°(€€€É•ÅÕ•ÍÑ•è€ÈÐ°(€€€¡½ÍÑ•¥±¥¹œè€ÄØ°(€€€½Ñ¡•ÉQ…Í­I•Í•ÉÙ…Ñ¥½¹Ìè€Ì°(€ô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹¡½ÍÑ•¥±¥¹MÑ…ÑÕÌ°€É•Á½ÉÑ•œ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹…Ù…¥±…‰±•…Á…¥Ñä°€ÄÌ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹…•ÁÑ9•Ý1…¹•Ì°™…±Í”¤ì)ô¤ì()Ñ•ÍÐ Õ¹­¹½Ý¸¡½ÍÐ•¥±¥¹œ¥ÌÉ•Á½ÉÑ•Ý¥Ñ¡½ÕÐ¥¹Ù•¹Ñ¥¹œ„ÉÕ¹Ñ¥µ”±¥µ¥Ðœ°€ ¤€ôøì(€½¹ÍÐÕ…É€ôÁ±…¹M•ÍÍ¥½¹Õ…É¡ì(€€€ÁÔèì±½¥…±½Õ¹Ðè€ÌÈ°¹½Éµ…±¥é•‘1½…è€À¸Äô°(€€€µ•µ½Éäèì™É••	åÑ•Ìè‰åÑ•Ì ØÐ¤°ÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Èô°(€€€‘¥Í¬èìÁÉ•ÍÍÕÉ•I…Ñ¥¼è€À¸Äô°(€€€½¹ÕÉÉ•¹äèìÕÉÉ•¹Ðè€Àô°(€ô°ìÁÉ½™¥±”è€™…ÍÐœ°­¥¹è€¥¼œ°É•ÅÕ•ÍÑ•è€ÈÐô¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹¡½ÍÑ•¥±¥¹œ°¹Õ±°¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹¡½ÍÑ•¥±¥¹MÑ…ÑÕÌ°€Õ¹­¹½Ý¸œ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡Õ…É¹Í…™•…Á…¥Ñä°€ÈÐ¤ì)ô¤ì