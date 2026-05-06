import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

import { atomicWriteFile } from '../agent/safety';

const TMP = join(process.cwd(), 'tmp', 'synax-safety-tests');

describe('atomicWriteFile', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('uses collision-resistant temporary names for concurrent writes', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234567890);
    const target = join(TMP, 'atomic.txt');

    await expect(
      Promise.all(Array.from({ length: 20 }, (_, index) => atomicWriteFile(target, `content ${index}`))),
    ).resolves.toBeDefined();

    expect(readFileSync(target, 'utf-8')).toMatch(/^content \d+$/);
  });
});
