/** Mario Kart-style chase camera renderer.
 *
 * The simulation stays 2D top-down; only the camera changed. Rendering is
 * classic pseudo-3D ("mode 7"):
 *   1. The static world (ground, road, start line) is baked once into an
 *      offscreen texture.
 *   2. Each frame that texture is drawn rotated around the camera into an
 *      intermediate canvas so "ahead" points up.
 *   3. Each screen row below the horizon samples one horizontal strip of the
 *      rotated view at the right depth — that's the perspective ground.
 *   4. Everything on the ground (karts, blocks, hazards, bullets, scenery)
 *      is projected and drawn as scaled sprites, far-to-near.
 */
import { mulberry32 } from '../../../shared/rng';
import { trapClosed, type Biome, type Track } from '../../../shared/track';
import type { PlayerInfo } from '../../../shared/protocol';
import { colorForSlot, DEFAULT_CAR, type CarKind } from '../../../shared/cars';
import { PETS, type PetKind } from '../../../shared/pets';
import type { RaceEngine } from './engine';

export { PLAYER_COLORS as KART_COLORS } from '../../../shared/cars';

const HORIZON_FRAC = 0.4;
const CAM_HEIGHT = 48; // world units above the ground
const CAM_BACK = 130; // camera ground point this far behind the kart
const FAR = 1400; // draw distance in world units

const ROT_SIZE = 2048;
const ROT_SCALE = 0.8; // world units -> rotated-view pixels
const ROT_CAM_X = ROT_SIZE / 2;
const ROT_CAM_Y = ROT_SIZE - 160;

const SKY: Record<Biome, [string, string]> = {
  jungle: ['#5eb1e6', '#d3f0c0'],
  snow: ['#8fa9cc', '#eef4fb'],
  desert: ['#6fb9e8', '#ffd9a0'],
  volcano: ['#2a0c14', '#ff6a33'],
};

const DECO_EMOJI: Record<string, string> = {
  tree: '🌴', bush: '🌿', flower: '🌺',
  pine: '🌲', snowman: '⛄', rock: '🪨',
  cactus: '🌵', skull: '💀',
  lava: '🔥', boulder: '🪨', ember: '✨',
};

interface Sprite {
  z: number;
  draw: () => void;
}

export class ChaseRenderer {
  private track: Track;
  private worldTex: HTMLCanvasElement;
  private texScale: number;
  private rotView: HTMLCanvasElement;
  private rotCtx: CanvasRenderingContext2D;
  private camHeading: number | null = null;
  private lastTime = 0;
  private minimapColors: string[] | null = null;

  constructor(track: Track) {
    this.track = track;
    const b = track.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    this.texScale = Math.min(2048 / w, 2048 / h, 1.2);
    this.worldTex = document.createElement('canvas');
    this.worldTex.width = Math.ceil(w * this.texScale);
    this.worldTex.height = Math.ceil(h * this.texScale);
    this.bakeWorld();

    this.rotView = document.createElement('canvas');
    this.rotView.width = ROT_SIZE;
    this.rotView.height = ROT_SIZE;
    this.rotCtx = this.rotView.getContext('2d')!;
  }

  /** Draw the static world once: ground, speckles, road, edges, start line. */
  private bakeWorld(): void {
    const { track } = this;
    const b = track.bounds;
    const ctx = this.worldTex.getContext('2d')!;
    const theme = track.theme;
    ctx.setTransform(this.texScale, 0, 0, this.texScale, -b.minX * this.texScale, -b.minY * this.texScale);

    ctx.fillStyle = theme.ground;
    ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);

    const rand = mulberry32(track.seed ^ 0x5eed);
    ctx.fillStyle = theme.groundDots;
    for (let i = 0; i < 900; i++) {
      const x = b.minX + rand() * (b.maxX - b.minX);
      const y = b.minY + rand() * (b.maxY - b.minY);
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + rand() * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const path = new Path2D();
    const c = track.center;
    path.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < c.length; i++) path.lineTo(c[i].x, c[i].y);
    path.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = theme.roadEdge;
    ctx.lineWidth = track.halfWidth * 2 + 12;
    ctx.stroke(path);
    ctx.strokeStyle = theme.road;
    ctx.lineWidth = track.halfWidth * 2;
    ctx.stroke(path);

    // subtle center dashes help judge corners in perspective
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 4;
    ctx.setLineDash([26, 34]);
    ctx.stroke(path);
    ctx.setLineDash([]);

    const s = track.center[0];
    const sn = track.normal[0];
    const sq = 9;
    for (let row = 0; row < 2; row++) {
      for (let i = -Math.floor(track.halfWidth / sq); i * sq < track.halfWidth; i++) {
        ctx.fillStyle = (i + row) % 2 === 0 ? theme.startLine : '#111';
        const cx = s.x + sn.x * i * sq - sn.y * row * sq;
        const cy = s.y + sn.y * i * sq + sn.x * row * sq;
        ctx.fillRect(cx - sq / 2, cy - sq / 2, sq, sq);
      }
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    engine: RaceEngine,
    time: number,
    players: PlayerInfo[], // slot-indexed
  ): void {
    const colorOf = (slot: number) => players[slot]?.color ?? colorForSlot(slot);
    const carOf = (slot: number) => players[slot]?.car ?? DEFAULT_CAR;
    const petOf = (slot: number) => players[slot]?.pet ?? null;
    this.minimapColors = players.map((p, i) => p?.color ?? colorForSlot(i));
    const { track } = this;
    const theme = track.theme;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const horizon = Math.round(h * HORIZON_FRAC);
    const F = h * 0.9;

    const dt = Math.min(0.05, Math.max(0.001, time - this.lastTime));
    this.lastTime = time;

    // Camera follows my kart's heading, softly.
    if (this.camHeading === null) this.camHeading = engine.heading;
    let dh = engine.heading - this.camHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.camHeading += dh * (1 - Math.exp(-dt * 7));

    const fwdX = Math.cos(this.camHeading);
    const fwdY = Math.sin(this.camHeading);
    const rightX = -fwdY;
    const rightY = fwdX;
    const camX = engine.x - fwdX * CAM_BACK;
    const camY = engine.y - fwdY * CAM_BACK;

    const shake = engine.shakeT > 0 ? engine.shakeT * 6 : 0;
    const shakeX = (Math.random() - 0.5) * shake;
    const shakeY = (Math.random() - 0.5) * shake;

    // --- sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    const [skyTop, skyBottom] = SKY[track.biome];
    sky.addColorStop(0, skyTop);
    sky.addColorStop(1, skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 2);
    // drifting clouds parallax against heading
    ctx.font = `${Math.round(h * 0.05)}px system-ui`;
    ctx.textAlign = 'center';
    const cloudShift = (-this.camHeading / (Math.PI * 2)) * w * 2;
    for (const [cx, cy] of [[0.15, 0.12], [0.5, 0.2], [0.85, 0.09], [0.33, 0.26]] as const) {
      const x = ((cx * w + cloudShift) % (w + 200) + w + 200) % (w + 200) - 100;
      ctx.fillText('☁️', x, cy * h);
    }

    // --- rotated world view (ahead = up)
    const rc = this.rotCtx;
    rc.setTransform(1, 0, 0, 1, 0, 0);
    rc.fillStyle = theme.ground;
    rc.fillRect(0, 0, ROT_SIZE, ROT_SIZE);
    rc.translate(ROT_CAM_X, ROT_CAM_Y);
    rc.rotate(-Math.PI / 2 - this.camHeading);
    rc.scale(ROT_SCALE, ROT_SCALE);
    rc.translate(-camX, -camY);
    rc.translate(track.bounds.minX, track.bounds.minY);
    rc.scale(1 / this.texScale, 1 / this.texScale);
    rc.drawImage(this.worldTex, 0, 0);

    // --- perspective ground, one strip per screen row
    const startRow = horizon + Math.max(2, Math.ceil((CAM_HEIGHT * F) / FAR));
    // fog band between horizon and first sampled row
    ctx.fillStyle = skyBottom;
    ctx.fillRect(0, horizon, w, startRow - horizon);
    for (let sy = startRow; sy < h; sy++) {
      const z = (CAM_HEIGHT * F) / (sy - horizon);
      const halfWorld = (w / 2) * (z / F);
      const srcW = halfWorld * 2 * ROT_SCALE;
      const srcX = ROT_CAM_X - halfWorld * ROT_SCALE;
      const srcY = ROT_CAM_Y - z * ROT_SCALE;
      ctx.drawImage(this.rotView, srcX, srcY - 0.5, srcW, 1, shakeX, sy + shakeY, w, 1);
    }

    // --- sprite projection
    const project = (wx: number, wy: number) => {
      const dx = wx - camX;
      const dy = wy - camY;
      const z = dx * fwdX + dy * fwdY;
      if (z < 16 || z > FAR) return null;
      const lat = dx * rightX + dy * rightY;
      return {
        sx: w / 2 + (lat / z) * F + shakeX,
        sy: horizon + (CAM_HEIGHT / z) * F + shakeY,
        s: F / z,
        z,
      };
    };

    const sprites: Sprite[] = [];
    const push = (wx: number, wy: number, drawFn: (sx: number, sy: number, s: number) => void) => {
      const p = project(wx, wy);
      if (p) sprites.push({ z: p.z, draw: () => drawFn(p.sx, p.sy, p.s) });
    };

    for (const d of track.decorations) {
      push(d.x, d.y, (sx, sy, s) => {
        const size = d.size * 2.2 * s;
        // skip too-small (far) and too-close (would fill the screen) scenery
        if (size < 4 || size > h * 0.22) return;
        ctx.font = `${Math.round(size)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(DECO_EMOJI[d.kind] ?? '🌳', sx, sy);
      });
    }

    for (const hz of track.hazards) {
      if (hz.kind === 'spikes') {
        push(hz.x, hz.y, (sx, sy, s) => this.drawSpikes(ctx, sx, sy, hz.radius * s));
      } else {
        push(hz.x, hz.y, (sx, sy, s) =>
          this.drawTrap(ctx, sx, sy, hz.radius * s, trapClosed(hz, engine.raceTime)),
        );
      }
    }

    for (const p of engine.puddles) {
      push(p.x, p.y, (sx, sy, s) => {
        ctx.fillStyle = 'rgba(20,16,28,0.85)';
        ctx.beginPath();
        ctx.ellipse(sx, sy, 22 * s, 9 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(120,90,200,0.4)';
        ctx.beginPath();
        ctx.ellipse(sx - 5 * s, sy - 2 * s, 9 * s, 3.5 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    for (const b of track.blocks) {
      const active = engine.blockActive(b.id);
      push(b.x, b.y, (sx, sy, s) => this.drawLuckyBlock(ctx, sx, sy, s, active, time, b.id));
    }

    for (const rb of engine.roadBlocks) {
      // cap the crate so a just-dropped block doesn't fill the screen
      push(rb.x, rb.y, (sx, sy, s) => this.drawRoadBlock(ctx, sx, sy, Math.min(s, (h * 0.09) / 20)));
    }

    for (const t of engine.turrets) {
      push(t.x, t.y, (sx, sy, s) => this.drawTurret(ctx, sx, sy, s, t.aimAngle - this.camHeading!, colorOf(t.ownerSlot), engine.raceTime - t.lastShot < 0.15));
    }

    for (const r of engine.rockets) {
      push(r.x, r.y, (sx, sy, s) => {
        const size = Math.max(11, 34 * s);
        // exhaust glow
        const glow = ctx.createRadialGradient(sx, sy - 12 * s, 0, sx, sy - 12 * s, size);
        glow.addColorStop(0, 'rgba(255,200,90,0.8)');
        glow.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy - 12 * s, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${Math.round(size)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(sx, sy - 12 * s);
        ctx.rotate(Math.sin(time * 9) * 0.15 + Math.PI * 0.4);
        ctx.fillText('🚀', 0, 0);
        ctx.restore();
      });
    }

    for (const bl of engine.bullets) {
      const mine = bl.shooterSlot === engine.slot;
      push(bl.x, bl.y, (sx, sy, s) => {
        const r = Math.max(2.5, 6 * s);
        const glow = ctx.createRadialGradient(sx, sy - 10 * s, 0, sx, sy - 10 * s, r * 2.4);
        glow.addColorStop(0, mine ? '#fff8c0' : '#ffd0d0');
        glow.addColorStop(1, 'rgba(255,160,40,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy - 10 * s, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mine ? '#ffb52e' : '#ff5238';
        ctx.beginPath();
        ctx.arc(sx, sy - 10 * s, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    for (const peer of engine.peers.values()) {
      let rel = peer.heading - this.camHeading;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      push(peer.x, peer.y, (sx, sy, s) =>
        this.drawKart(ctx, sx, sy, s, colorOf(peer.slot), players[peer.slot]?.username ?? '', peer.effect, rel * 0.45, time, carOf(peer.slot), petOf(peer.slot)),
      );
    }

    {
      const steerTilt =
        engine.displayEffect() === 'spin' ? engine.spinAngle : (dh || 0) * 1.6;
      push(engine.x, engine.y, (sx, sy, s) =>
        this.drawKart(ctx, sx, sy, s, colorOf(engine.slot), '', engine.displayEffect(), steerTilt, time, carOf(engine.slot), petOf(engine.slot)),
      );
    }

    sprites.sort((a, b) => b.z - a.z);
    for (const sp of sprites) sp.draw();

    this.drawMinimap(ctx, engine, w);
  }

  private drawSpikes(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number): void {
    if (r < 2) return;
    ctx.fillStyle = '#6d6d78';
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8d8e2';
    for (let i = -2; i <= 2; i++) {
      const bx = sx + i * r * 0.42;
      ctx.beginPath();
      ctx.moveTo(bx - r * 0.16, sy);
      ctx.lineTo(bx, sy - r * 1.1);
      ctx.lineTo(bx + r * 0.16, sy);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawTrap(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, closed: boolean): void {
    if (r < 2) return;
    ctx.fillStyle = closed ? '#b02e2e' : '#3a3a44';
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e6e6ef';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    if (closed) {
      ctx.beginPath();
      ctx.moveTo(sx - r * 0.7, sy - r * 0.1);
      ctx.lineTo(sx + r * 0.7, sy - r * 0.1);
      ctx.stroke();
      ctx.fillStyle = '#e6e6ef';
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(sx + i * r * 0.3 - r * 0.1, sy - r * 0.1);
        ctx.lineTo(sx + i * r * 0.3, sy - r * 0.55);
        ctx.lineTo(sx + i * r * 0.3 + r * 0.1, sy - r * 0.1);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(sx, sy - r * 0.1, r * 0.72, r * 0.62, 0, side > 0 ? Math.PI : 0, side > 0 ? 2 * Math.PI : Math.PI);
        ctx.stroke();
      }
    }
  }

  private drawLuckyBlock(
    ctx: CanvasRenderingContext2D,
    sx: number, sy: number, s: number,
    active: boolean, time: number, id: number,
  ): void {
    const size = 17 * s;
    if (size < 2.5) return;
    const bob = active ? Math.sin(time * 2.2 + id) * 6 * s : 0;
    const cy = sy - 16 * s + bob;
    ctx.save();
    ctx.translate(sx, cy);
    ctx.rotate(Math.sin(time * 1.4 + id) * 0.22);
    if (active) {
      const grad = ctx.createLinearGradient(-size, -size, size, size);
      grad.addColorStop(0, '#ffd23e');
      grad.addColorStop(1, '#ff8c00');
      ctx.fillStyle = grad;
      ctx.strokeStyle = '#7a4a00';
    } else {
      ctx.fillStyle = 'rgba(255,210,62,0.15)';
      ctx.strokeStyle = 'rgba(122,74,0,0.3)';
    }
    ctx.lineWidth = Math.max(1, 2.4 * s);
    ctx.beginPath();
    ctx.roundRect(-size, -size, size * 2, size * 2, 4 * s);
    ctx.fill();
    ctx.stroke();
    if (active && size > 6) {
      ctx.fillStyle = '#5a3600';
      ctx.font = `bold ${Math.round(size * 1.3)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, size * 0.06);
    }
    ctx.restore();
    if (active) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(sx, sy, size * 0.9, size * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRoadBlock(ctx: CanvasRenderingContext2D, sx: number, sy: number, s: number): void {
    const half = 20 * s;
    if (half < 2) return;
    const hgt = half * 1.15;
    // front face
    ctx.fillStyle = '#a4682f';
    ctx.strokeStyle = '#5e3a17';
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.rect(sx - half, sy - hgt, half * 2, hgt);
    ctx.fill();
    ctx.stroke();
    // X brace
    ctx.beginPath();
    ctx.moveTo(sx - half, sy - hgt);
    ctx.lineTo(sx + half, sy);
    ctx.moveTo(sx + half, sy - hgt);
    ctx.lineTo(sx - half, sy);
    ctx.stroke();
    // top face
    ctx.fillStyle = '#c1854a';
    ctx.beginPath();
    ctx.moveTo(sx - half, sy - hgt);
    ctx.lineTo(sx - half * 0.7, sy - hgt - half * 0.42);
    ctx.lineTo(sx + half * 1.3 - half * 0.6, sy - hgt - half * 0.42);
    ctx.lineTo(sx + half, sy - hgt);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawTurret(
    ctx: CanvasRenderingContext2D,
    sx: number, sy: number, s: number,
    aim: number, ownerColor: string, justFired: boolean,
  ): void {
    const r = 16 * s;
    if (r < 2) return;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // base
    ctx.fillStyle = '#4a5260';
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.roundRect(sx - r * 0.8, sy - r * 1.5, r * 1.6, r * 1.5, r * 0.25);
    ctx.fill();
    ctx.stroke();
    // owner stripe
    ctx.fillStyle = ownerColor;
    ctx.fillRect(sx - r * 0.8, sy - r * 0.55, r * 1.6, r * 0.28);
    // barrel (screen-space approximation of world aim)
    const bx = Math.cos(aim + Math.PI / 2);
    ctx.strokeStyle = justFired ? '#ffd23e' : '#20242c';
    ctx.lineWidth = Math.max(2, r * 0.3);
    ctx.beginPath();
    ctx.moveTo(sx, sy - r * 1.3);
    ctx.lineTo(sx + bx * r * 1.1, sy - r * 1.3 - r * 0.5);
    ctx.stroke();
    if (justFired) {
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.arc(sx + bx * r * 1.2, sy - r * 1.35 - r * 0.5, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawKart(
    ctx: CanvasRenderingContext2D,
    sx: number, sy: number, s: number,
    color: string, name: string,
    effect: string | null, tilt: number, time: number,
    car: CarKind = DEFAULT_CAR,
    pet: PetKind | null = null,
  ): void {
    const shrink = effect === 'shrink' ? 0.62 : 1;
    const carW = car === 'boulder' ? 1.14 : car === 'blaze' ? 0.95 : 1;
    const wpx = 34 * s * shrink * carW;
    const hpx = wpx * (car === 'boulder' ? 0.68 : 0.6);
    if (wpx < 3) return;

    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, wpx * 0.62, wpx * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(sx, sy - hpx * 0.55);
    ctx.rotate(effect === 'spin' ? tilt : Math.max(-0.3, Math.min(0.3, tilt)) * 0.5);

    if (effect === 'boost') {
      const flick = 1 + 0.35 * Math.sin(time * 42);
      ctx.fillStyle = '#ff9f1c';
      ctx.beginPath();
      ctx.moveTo(-wpx * 0.2, hpx * 0.5);
      ctx.lineTo(0, hpx * 0.5 + hpx * flick);
      ctx.lineTo(wpx * 0.2, hpx * 0.5);
      ctx.closePath();
      ctx.fill();
    }

    // wheels
    ctx.fillStyle = '#1c1c1e';
    const wr = wpx * 0.16;
    ctx.fillRect(-wpx / 2 - wr * 0.4, hpx * 0.1, wr, hpx * 0.5);
    ctx.fillRect(wpx / 2 - wr * 0.6, hpx * 0.1, wr, hpx * 0.5);
    // body (rear view)
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    ctx.roundRect(-wpx / 2, -hpx * 0.25, wpx, hpx * 0.85, wpx * 0.14);
    ctx.fill();
    ctx.stroke();
    // spoiler (Drift King gets a huge one; Blaze gets a fin)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    if (car === 'drift') ctx.fillRect(-wpx * 0.55, -hpx * 0.5, wpx * 1.1, hpx * 0.2);
    else if (car === 'blaze') {
      ctx.beginPath();
      ctx.moveTo(-wpx * 0.06, -hpx * 0.42);
      ctx.lineTo(0, -hpx * 0.78);
      ctx.lineTo(wpx * 0.06, -hpx * 0.42);
      ctx.closePath();
      ctx.fill();
    } else ctx.fillRect(-wpx * 0.42, -hpx * 0.42, wpx * 0.84, hpx * 0.16);
    if (car === 'lucky') {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      for (const [dxr, dyr] of [[-0.25, 0.1], [0.22, 0.05], [0, 0.3]] as const) {
        ctx.beginPath();
        ctx.arc(wpx * dxr, hpx * dyr, wpx * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // driver helmet
    ctx.fillStyle = '#f5f5f7';
    ctx.beginPath();
    ctx.arc(0, -hpx * 0.34, wpx * 0.16, 0, Math.PI * 2);
    ctx.fill();

    if (effect === 'sword') {
      ctx.save();
      ctx.rotate(Math.sin(time * 10) * 0.7);
      ctx.strokeStyle = '#e8ecff';
      ctx.lineWidth = Math.max(2, wpx * 0.09);
      ctx.beginPath();
      ctx.moveTo(wpx * 0.55, -hpx * 0.2);
      ctx.lineTo(wpx * 1.15, -hpx * 1.1);
      ctx.stroke();
      ctx.strokeStyle = '#8a5a2b';
      ctx.beginPath();
      ctx.moveTo(wpx * 0.5, -hpx * 0.1);
      ctx.lineTo(wpx * 0.62, -hpx * 0.32);
      ctx.stroke();
      ctx.restore();
    }
    if (effect === 'barrier') {
      ctx.fillStyle = 'rgba(90,220,255,0.18)';
      ctx.strokeStyle = 'rgba(90,220,255,0.75)';
      ctx.lineWidth = Math.max(1.5, 2.5 * s);
      ctx.beginPath();
      ctx.arc(0, -hpx * 0.15, wpx * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (effect === 'shield') {
      ctx.strokeStyle = 'rgba(90,220,255,0.9)';
      ctx.lineWidth = Math.max(1.5, 3 * s);
      ctx.beginPath();
      ctx.arc(0, 0, wpx * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    if (pet && wpx > 9) {
      // pet sidekick bobs along beside the kart
      const bob = Math.sin(time * 3.1 + sx * 0.02) * hpx * 0.1;
      ctx.font = `${Math.round(wpx * 0.42)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(PETS[pet].emoji, sx - wpx * 0.85, sy - hpx * 0.9 + bob);
    }

    if (effect === 'dj') {
      // disco ball over the head + party sparkles
      const bob = Math.sin(time * 2.4) * hpx * 0.08;
      ctx.save();
      ctx.translate(sx, sy - hpx * 1.75 + bob);
      ctx.font = `${Math.round(wpx * 0.62)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🪩', 0, 0);
      for (let i = 0; i < 4; i++) {
        const a = time * 2.8 + (i * Math.PI) / 2;
        ctx.fillStyle = ['#ff5252', '#ffd23e', '#4dd0e1', '#c792ea'][i];
        ctx.beginPath();
        ctx.arc(Math.cos(a) * wpx * 0.55, Math.sin(a) * wpx * 0.28, Math.max(1.5, wpx * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (effect === 'scare') {
      ctx.font = `${Math.round(wpx * 0.7)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('😱', sx, sy - hpx * 1.7);
    }
    if (effect === 'hypno') {
      ctx.save();
      ctx.translate(sx, sy - hpx * 1.7);
      ctx.rotate(time * 6);
      ctx.font = `${Math.round(wpx * 0.7)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🌀', 0, 0);
      ctx.restore();
    }
    if (name && wpx > 10) {
      ctx.font = `bold ${Math.max(11, 13 * Math.min(1, s * 2))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeText(name, sx, sy - hpx * 2.1);
      ctx.fillText(name, sx, sy - hpx * 2.1);
    }
  }

  private drawMinimap(ctx: CanvasRenderingContext2D, engine: RaceEngine, canvasW: number): void {
    const { track } = this;
    const size = 150;
    const pad = 14;
    const bx = canvasW - size - pad;
    const by = pad;
    const b = track.bounds;
    const sc = Math.min(size / (b.maxX - b.minX), size / (b.maxY - b.minY));
    const ox = bx + (size - (b.maxX - b.minX) * sc) / 2;
    const oy = by + (size - (b.maxY - b.minY) * sc) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(10,10,16,0.55)';
    ctx.beginPath();
    ctx.roundRect(bx - 8, by - 8, size + 16, size + 16, 10);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const c = track.center;
    ctx.moveTo(ox + (c[0].x - b.minX) * sc, oy + (c[0].y - b.minY) * sc);
    for (let i = 4; i < c.length; i += 4) {
      ctx.lineTo(ox + (c[i].x - b.minX) * sc, oy + (c[i].y - b.minY) * sc);
    }
    ctx.closePath();
    ctx.stroke();

    const dot = (x: number, y: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ox + (x - b.minX) * sc, oy + (y - b.minY) * sc, 4.5, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const peer of engine.peers.values()) dot(peer.x, peer.y, this.minimapColors?.[peer.slot] ?? '#fff');
    dot(engine.x, engine.y, this.minimapColors?.[engine.slot] ?? '#fff');
    ctx.restore();
  }
}
