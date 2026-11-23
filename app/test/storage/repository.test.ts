import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../../src/storage/repository';
import { SKEWED_MOUNT } from '../helpers';
import { DEFAULT_SETTINGS } from '../../src/app/settings';

describe('IndexedDbRepository', () => {
  it('persists calibration per device, settings, sessions and strokes', async () => {
    const repo = await IndexedDbRepository.open(`test-${String(Math.random())}`);
    expect(await repo.loadCalibration('A')).toBeNull();
    await repo.saveCalibration('A', SKEWED_MOUNT);
    expect(await repo.loadCalibration('A')).toEqual(SKEWED_MOUNT);
    expect(await repo.loadCalibration('B')).toBeNull();

    await repo.saveSettings(DEFAULT_SETTINGS);
    expect(await repo.loadSettings()).toEqual(DEFAULT_SETTINGS);

    await repo.saveSession({ id: 'old', startedAt: 1, label: 'old' });
    await repo.saveSession({ id: 'new', startedAt: 2, label: 'new' });
    expect((await repo.listSessions()).map((s) => s.id)).toEqual(['new', 'old']);
  });
});
