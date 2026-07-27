/** Lobby: create a game (level + biome), join by code, shop, stats + leaderboard. */
import { useEffect, useState } from 'react';
import { api, formatMs, type LeaderboardRow, type User } from '../api';
import { BIOME_LIST, BIOMES, type Biome } from '../../../shared/track';
import { CAPS, PRICES, type ShopItem } from '../../../shared/economy';
import { CARS, CAR_LIST, PLAYER_COLORS, type CarKind } from '../../../shared/cars';
import { PETS, PET_LIST, type PetKind } from '../../../shared/pets';

const LEVEL_LABELS = ['Big Circle', 'Twisty', 'Hazard Run', 'Chaos', 'Gauntlet'];

const SHOP_ROWS: { item: ShopItem; emoji: string; label: string; desc: string }[] = [
  { item: 'bullet', emoji: '🔫', label: 'Bullet', desc: 'F to fire — spins your rival' },
  { item: 'block', emoji: '📦', label: 'Road block', desc: `B to drop one (max ${CAPS.blocks} owned)` },
  { item: 'armorBullet', emoji: '🛡️', label: 'Bullet armor', desc: 'Absorbs one bullet hit' },
  { item: 'armorBlock', emoji: '🪖', label: 'Block armor', desc: 'Absorbs one road-block crash' },
  { item: 'turret', emoji: '🗼', label: 'Turret', desc: 'T to place — auto-shoots rivals for 30s' },
  { item: 'boom', emoji: '💥', label: 'BOOM', desc: 'X — everyone else back to the start. ONE per race!' },
  { item: 'hypno', emoji: '🌀', label: 'Hypnotize', desc: 'H — everyone drives like you for 6s. Once per race.' },
];

interface Props {
  user: User;
  onCreate: (level: number, biome: Biome | 'random') => void;
  onJoin: (code: string) => void;
  onLogout: () => void;
  onUserUpdate: (user: User) => void;
  busy: boolean;
}

export function Lobby({ user, onCreate, onJoin, onLogout, onUserUpdate, busy }: Props) {
  const [level, setLevel] = useState(1);
  const [biome, setBiome] = useState<Biome | 'random'>('random');
  const [joinCode, setJoinCode] = useState('');
  const [board, setBoard] = useState<LeaderboardRow[] | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    api.leaderboard().then((r) => setBoard(r.players)).catch(() => setBoard([]));
  }, []);

  const buy = async (item: ShopItem, qty: number) => {
    setShopError(null);
    setBuying(true);
    try {
      onUserUpdate(await api.buy(item, qty));
    } catch (err) {
      setShopError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBuying(false);
    }
  };

  const owned = (item: ShopItem): number => {
    const w = user.wallet;
    switch (item) {
      case 'bullet': return w.bullets;
      case 'block': return w.blocks;
      case 'armorBullet': return w.armorBullets;
      case 'armorBlock': return w.armorBlocks;
      case 'turret': return w.turrets;
      case 'boom': return w.booms;
      case 'hypno': return w.hypnos;
    }
  };

  const saveProfile = async (patch: { color?: string; car?: CarKind; activePet?: PetKind | null }) => {
    try {
      onUserUpdate(await api.profile(patch));
    } catch {
      // cosmetic — ignore transient failures
    }
  };

  const buyPet = async (pet: PetKind) => {
    setShopError(null);
    setBuying(true);
    try {
      onUserUpdate(await api.buyPet(pet));
    } catch (err) {
      setShopError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBuying(false);
    }
  };

  return (
    <div className="lobby">
      <header className="lobby-header">
        <div>
          <h1 className="logo">🏁 Vancouver Road Simulator</h1>
          <p className="credit">by Jasper, Skyler, Dad and Fable</p>
        </div>
        <div className="user-chip">
          <strong>{user.username}</strong>
          <span className="points-chip">⭐ {user.wallet.points} pts</span>
          <span className="muted">
            {user.stats.wins}W / {user.stats.losses}L · best lap {formatMs(user.stats.bestLapMs)}
          </span>
          <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="lobby-grid">
        <div className="card">
          <h2>Create a race</h2>
          <p className="muted">You'll get a 5-digit code — up to 10 racers can join before you start.</p>

          <label className="field-label">Difficulty</label>
          <div className="option-row">
            {[1, 2, 3, 4, 5].map((l) => (
              <button
                key={l}
                className={`option ${level === l ? 'selected' : ''}`}
                onClick={() => setLevel(l)}
              >
                <span className="option-big">{l}</span>
                <span className="option-small">{LEVEL_LABELS[l - 1]}</span>
              </button>
            ))}
          </div>

          <label className="field-label">Biome</label>
          <div className="option-row">
            <button
              className={`option ${biome === 'random' ? 'selected' : ''}`}
              onClick={() => setBiome('random')}
            >
              <span className="option-big">🎲</span>
              <span className="option-small">Random</span>
            </button>
            {BIOME_LIST.map((b) => (
              <button
                key={b}
                className={`option ${biome === b ? 'selected' : ''}`}
                onClick={() => setBiome(b)}
              >
                <span className="option-big">{BIOMES[b].emoji}</span>
                <span className="option-small">{BIOMES[b].label}</span>
              </button>
            ))}
          </div>

          <button className="btn btn-primary" disabled={busy} onClick={() => onCreate(level, biome)}>
            {busy ? '…' : 'Create race'}
          </button>
        </div>

        <div className="card">
          <h2>Join a race</h2>
          <p className="muted">Got a code from a friend? Punch it in.</p>
          <div className="join-row">
            <input
              placeholder="12345"
              inputMode="numeric"
              maxLength={5}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && joinCode.length === 5) onJoin(joinCode);
              }}
            />
            <button
              className="btn btn-primary"
              disabled={busy || joinCode.length !== 5}
              onClick={() => onJoin(joinCode)}
            >
              Join
            </button>
          </div>

          <h2 className="how-title">How to play</h2>
          <ul className="how-list">
            <li>🕹️ <kbd>↑</kbd> accelerate, <kbd>↓</kbd> brake, <kbd>←</kbd><kbd>→</kbd> steer (or WASD)</li>
            <li>❓ Lucky blocks give a random item — fire it with <kbd>Space</kbd>: 👻 jump scare, 💨 boost, 🛢️ oil, ⚡ lightning, 🪩 DJ, 👻👻 double scare, 🚀 rocket…</li>
            <li>🔫 <kbd>F</kbd> shoots a bullet · 📦 <kbd>B</kbd> drops a road block behind you</li>
            <li>🤖 Hosts can add up to 20 robot racers in the waiting room</li>
            <li>⚠️ Dodge the spikes and snapping traps — higher levels have more</li>
            <li>🏁 First to finish 3 laps wins · earn ⭐ points every race to spend in the shop</li>
          </ul>
        </div>

        <div className="card">
          <h2>Garage</h2>
          <p className="muted">Pick your color and your ride — everyone sees them on track.</p>
          <label className="field-label">Color</label>
          <div className="swatch-row">
            {PLAYER_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${user.color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => saveProfile({ color: c })}
                aria-label={`color ${c}`}
              />
            ))}
          </div>
          <label className="field-label">Car</label>
          <div className="option-row">
            {CAR_LIST.map((kind) => (
              <button
                key={kind}
                className={`option car-option ${user.car === kind ? 'selected' : ''}`}
                onClick={() => saveProfile({ car: kind })}
              >
                <span className="option-big">{CARS[kind].emoji}</span>
                <span className="option-small">{CARS[kind].label}</span>
                <span className="car-desc">{CARS[kind].desc}</span>
              </button>
            ))}
          </div>

          <label className="field-label">Pet sidekick</label>
          <div className="option-row">
            <button
              className={`option car-option ${user.activePet === null ? 'selected' : ''}`}
              onClick={() => saveProfile({ activePet: null })}
            >
              <span className="option-big">🚫</span>
              <span className="option-small">No pet</span>
              <span className="car-desc">Ride solo</span>
            </button>
            {PET_LIST.map((kind) => {
              const ownedPet = user.pets.includes(kind);
              return (
                <button
                  key={kind}
                  className={`option car-option ${user.activePet === kind ? 'selected' : ''}`}
                  disabled={buying || (!ownedPet && user.wallet.points < PETS[kind].price)}
                  onClick={() => (ownedPet ? saveProfile({ activePet: kind }) : buyPet(kind))}
                >
                  <span className="option-big">{PETS[kind].emoji}</span>
                  <span className="option-small">{PETS[kind].label}</span>
                  <span className="car-desc">
                    {PETS[kind].desc}
                    {!ownedPet && <strong> · {PETS[kind].price} ⭐</strong>}
                  </span>
                </button>
              );
            })}
          </div>
          {shopError && <p className="error">{shopError}</p>}
        </div>

        <div className="card">
          <h2>Shop</h2>
          <p className="muted">Spend race points: win = 80 + 20×level, +5 per hit you land.</p>
          <table className="shop-table">
            <tbody>
              {SHOP_ROWS.map(({ item, emoji, label, desc }) => (
                <tr key={item}>
                  <td className="shop-emoji">{emoji}</td>
                  <td>
                    <strong>{label}</strong> <span className="muted">· own {owned(item)}</span>
                    <div className="muted shop-desc">{desc}</div>
                  </td>
                  <td className="shop-buy">
                    <button
                      className="btn btn-ghost"
                      disabled={buying || user.wallet.points < PRICES[item]}
                      onClick={() => buy(item, 1)}
                    >
                      {PRICES[item]} ⭐
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shopError && <p className="error">{shopError}</p>}
        </div>

        <div className="card leaderboard-card">
          <h2>Leaderboard</h2>
          {board === null ? (
            <p className="muted">Loading…</p>
          ) : board.length === 0 ? (
            <p className="muted">No racers yet — be the first!</p>
          ) : (
            <table className="board-table">
              <thead>
                <tr><th></th><th>Racer</th><th>W</th><th>L</th><th>Best lap</th></tr>
              </thead>
              <tbody>
                {board.map((row, i) => (
                  <tr key={row.username} className={row.username === user.username ? 'me-row' : ''}>
                    <td>{['🥇', '🥈', '🥉'][i] ?? i + 1}</td>
                    <td>{row.username}</td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td>{formatMs(row.bestLapMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
