import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';

const payload: BotEvents['game:finished'] = {
  sessionId: 's1',
  guildId: 'g1',
  game: 'mole',
  winnerIds: ['u1'],
  loserIds: ['u2'],
  finishedAt: 0,
};

describe('EventBus', () => {
  it('délivre le payload aux abonnés et permet le désabonnement', async () => {
    const bus = new EventBus<BotEvents>();
    const handler = vi.fn();
    const off = bus.on('game:finished', handler);
    await bus.emit('game:finished', payload);
    off();
    await bus.emit('game:finished', payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("isole un listener en échec : les autres s'exécutent et emit ne rejette pas", async () => {
    const logger = { ...nullLogger, error: vi.fn() };
    const bus = new EventBus<BotEvents>(logger);
    const ok = vi.fn();
    bus.on('game:finished', () => {
      throw new Error('boom');
    });
    bus.on('game:finished', async () => Promise.reject(new Error('async boom')));
    bus.on('game:finished', ok);
    await expect(bus.emit('game:finished', payload)).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("once ne se déclenche qu'une fois", async () => {
    const bus = new EventBus<BotEvents>();
    const handler = vi.fn();
    bus.once('game:finished', handler);
    await bus.emit('game:finished', payload);
    await bus.emit('game:finished', payload);
    expect(handler).toHaveBeenCalledOnce();
    expect(bus.listenerCount('game:finished')).toBe(0);
  });
});
