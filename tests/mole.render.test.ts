import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { moleCustomId, parseMoleCustomId } from '../src/modules/games/mole/discord/ids.js';
import {
  clueModal,
  noticeFor,
  renderBoard,
  roleMessage,
  type BoardView,
} from '../src/modules/games/mole/discord/render.js';
import { createMoleMachine, roleOf } from '../src/modules/games/mole/machine.js';
import type { MoleState } from '../src/modules/games/mole/types.js';
import { everyoneVotes, lobby, started, step, toVoting } from './helpers/mole.js';

const machine = createMoleMachine();
const SID = '00000000-0000-4000-8000-000000000000';

const view = (state: MoleState, deadline: number | null = 1_700_000_000_000): BoardView => ({
  sessionId: SID,
  state,
  config: machine.config,
  deadline,
  name: (id) => `Nom de ${id}`,
});

/** JSON tel qu'envoyé à l'API : valide aussi les contraintes des builders (longueurs, champs requis). */
const json = (state: MoleState) => {
  const board = renderBoard(view(state));
  return {
    embed: board.embeds[0]?.toJSON(),
    rows: board.components.map((r) => r.toJSON()),
  };
};
const customIds = (rows: ReturnType<typeof json>['rows']) =>
  rows.flatMap((r) => r.components.map((c) => ('custom_id' in c ? c.custom_id : null)));

describe('customIds', () => {
  it('aller-retour et rejet des identifiants étrangers', () => {
    expect(parseMoleCustomId(moleCustomId('vote', SID))).toEqual({ action: 'vote', sessionId: SID });
    expect(moleCustomId('guessModal', SID).length).toBeLessThanOrEqual(100);
    expect(parseMoleCustomId(`other:vote:${SID}`)).toBeNull();
    expect(parseMoleCustomId(`mole:hack:${SID}`)).toBeNull();
    expect(parseMoleCustomId('mole:vote')).toBeNull();
    expect(parseMoleCustomId(`mole:vote:${SID}:extra`)).toBeNull();
  });
});

describe('plateau', () => {
  it('lobby : boutons de salle d’attente, Lancer désactivé sous le minimum', () => {
    const { embed, rows } = json(lobby(machine, ['a', 'b']));
    expect(customIds(rows)).toEqual(['join', 'leave', 'start', 'cancel'].map((a) => `mole:${a}:${SID}`));
    const startButton = rows[0]?.components[2];
    expect(startButton && 'disabled' in startButton && startButton.disabled).toBe(true);
    expect(embed?.fields?.[0]?.value).toContain('<@a>');
    expect(embed?.description).toContain('<t:1700000000:R>');
  });

  it('indices : ne révèle ni le mot ni la taupe, montre le joueur en cours', () => {
    const s = started(machine);
    const { embed, rows } = json(s);
    const text = JSON.stringify(embed);
    expect(text).not.toContain(s.word);
    expect(text).toContain(s.category);
    expect(embed?.description).toContain(`✍️ <@${s.turnOrder[0]}>`);
    expect(customIds(rows)).toEqual([`mole:clue:${SID}`, `mole:role:${SID}`, `mole:cancel:${SID}`]);
  });

  it('échappe le markdown des indices', () => {
    const s = started(machine);
    const r = step(machine, s, { type: 'clue', userId: s.turnOrder[0] as string, text: '**gras** _x_' });
    expect(json(r.state).embed?.description).toContain('\\*\\*gras\\*\\*');
  });

  it('vote : menu avec tous les joueurs, sans dévoiler qui vise qui', () => {
    let v: MoleState = toVoting(machine, started(machine));
    const [a, b] = v.players as [string, string];
    v = step(machine, v, { type: 'vote', userId: a, targetId: b }).state;
    const { embed, rows } = json(v);
    const select = rows[0]?.components[0];
    expect(select?.type).toBe(ComponentType.StringSelect);
    if (select?.type !== ComponentType.StringSelect) return;
    expect(select.options.map((o) => o.value)).toEqual([...v.players]);
    expect(select.options[0]?.label).toBe(`Nom de ${v.players[0]}`);
    expect(embed?.description).toContain('1/4');
    expect(embed?.description).not.toContain(`→ <@${b}>`);
  });

  it('fin : révèle le mot, la taupe et les votes, sans composants', () => {
    const v = toVoting(machine, started(machine));
    const end = everyoneVotes(machine, v, v.players.find((p) => p !== v.moleId) as string).state;
    const { embed, rows } = json(end);
    expect(rows).toEqual([]);
    expect(embed?.title).toContain('victoire de la taupe');
    expect(embed?.description).toContain(v.word);
    expect(embed?.description).toContain(`La taupe était <@${v.moleId}>`);
    expect(embed?.fields?.[0]?.value).toContain('→');
  });

  it('annulation : message adapté au motif', () => {
    const cancelled = step(machine, lobby(machine), { type: 'timeout', key: 'lobby' }).state;
    expect(json(cancelled).embed?.description).toContain('personne');
    expect(json(cancelled).rows).toEqual([]);
  });
});

describe('notices et messages privés', () => {
  it('ping le joueur dont c’est le tour, ignore les effets silencieux', () => {
    const s = started(machine);
    expect(noticeFor({ type: 'turnStarted', userId: 'bob', turnIndex: 1, round: 0 }, view(s))).toContain('<@bob>');
    expect(noticeFor({ type: 'voteCast', voterId: 'a', votesCast: 1, votesExpected: 4 }, view(s))).toBeNull();
  });

  it('le message de rôle ne donne le mot qu’aux agents', () => {
    const s = started(machine);
    const agent = s.players.find((p) => p !== s.moleId) as string;
    expect(roleMessage(roleOf(s, s.moleId)!)).not.toContain(s.word);
    expect(roleMessage(roleOf(s, agent)!)).toContain(s.word);
  });

  it('la modale d’indice respecte la longueur maximale configurée', () => {
    const modal = clueModal(SID, 25).toJSON();
    expect(JSON.stringify(modal)).toContain('"max_length":25');
    expect(modal.custom_id).toBe(`mole:clueModal:${SID}`);
  });
});
