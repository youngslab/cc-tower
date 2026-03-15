import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/tmux/commands.js', () => ({
  tmux: {
    isAvailable: vi.fn(),
    listPanes: vi.fn(),
  },
}));

vi.mock('../../src/utils/pid-resolver.js', () => ({
  resolvePaneForPid: vi.fn(),
}));

import { tmux } from '../../src/tmux/commands.js';
import { resolvePaneForPid } from '../../src/utils/pid-resolver.js';
import { mapPidToPane } from '../../src/tmux/pane-mapper.js';

const mockIsAvailable = vi.mocked(tmux.isAvailable);
const mockListPanes = vi.mocked(tmux.listPanes);
const mockResolvePaneForPid = vi.mocked(resolvePaneForPid);

const MOCK_PANES = [
  {
    paneId: '%1',
    tty: '/dev/pts/1',
    pid: 100,
    currentCommand: 'bash',
    currentPath: '/home/user/project',
    width: 200,
    height: 50,
    active: true,
    windowId: '@0',
    windowIndex: 0,
    sessionName: 'main',
  },
  {
    paneId: '%2',
    tty: '/dev/pts/2',
    pid: 200,
    currentCommand: 'nvim',
    currentPath: '/home/user/other',
    width: 200,
    height: 50,
    active: false,
    windowId: '@0',
    windowIndex: 0,
    sessionName: 'main',
  },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('mapPidToPane', () => {
  it('returns hasTmux: false when tmux is not available', async () => {
    mockIsAvailable.mockResolvedValueOnce(false);

    const result = await mapPidToPane(1234);
    expect(result).toEqual({ paneId: undefined, hasTmux: false });
    expect(mockListPanes).not.toHaveBeenCalled();
  });

  it('returns matched paneId on direct match', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockListPanes.mockResolvedValueOnce(MOCK_PANES);
    mockResolvePaneForPid.mockResolvedValueOnce({
      paneId: '%1',
      tty: '/dev/pts/1',
      ancestorPid: 1234,
    });

    const result = await mapPidToPane(1234);
    expect(result).toEqual({ paneId: '%1', hasTmux: true });
    expect(mockResolvePaneForPid).toHaveBeenCalledWith(1234, MOCK_PANES);
  });

  it('returns matched paneId when found via ppid chain (nvim nested)', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockListPanes.mockResolvedValueOnce(MOCK_PANES);
    // pid-resolver walks up the ppid chain and finds pane %2 via an ancestor
    mockResolvePaneForPid.mockResolvedValueOnce({
      paneId: '%2',
      tty: '/dev/pts/2',
      ancestorPid: 200,
    });

    const result = await mapPidToPane(9999);
    expect(result).toEqual({ paneId: '%2', hasTmux: true });
  });

  it('returns paneId: undefined when no matching pane found', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockListPanes.mockResolvedValueOnce(MOCK_PANES);
    mockResolvePaneForPid.mockResolvedValueOnce(null);

    const result = await mapPidToPane(5555);
    expect(result).toEqual({ paneId: undefined, hasTmux: true });
  });

  it('returns paneId: undefined when listPanes throws', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockListPanes.mockRejectedValueOnce(new Error('tmux list-panes failed: no server'));

    const result = await mapPidToPane(1234);
    expect(result).toEqual({ paneId: undefined, hasTmux: true });
  });
});
