import { verifyPlatformEnvironment } from '../../../core/security/platform-integrity';

export interface FlightFrame {
  phase: 'WAITING' | 'RUNNING' | 'CRASHED';
  multiplier: number;
  roomId: number;
  takeoff: boolean;
  frozen: boolean;
  animate?: boolean;
  themeMultiplier?: number;
  flightElapsedMs?: number;
}


/** Canvas animation has no Angular state writes or per-frame layout reads. */
export class AviatorFlightRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly background = document.createElement('canvas');
  private readonly backgroundCtx = this.background.getContext('2d')!;
  private readonly glow = document.createElement('canvas');
  private readonly glowCtx = this.glow.getContext('2d')!;
  private glowKey = '';
  private width = 0;
  private height = 0;
  private dpr = 1;
  private mobile = false;
  private backgroundKey = '';
  private staticFrameKey = '';
  private sprite: HTMLCanvasElement | null = null;
  private bodySprite: HTMLCanvasElement | null = null;
  private propellerSprite: HTMLCanvasElement | null = null;
  private previousPhase = '';
  private previousRoom = -1;
  private runningStartedAt = 0;
  private cruiseStartedAt: number | null = null;
  private rayAngle = 0;
  private plane = { x: 0, y: 0, visible: false };
  private exit: { startedAt: number; x: number; y: number } | null = null;
  lastRenderMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setSprite(sprite: HTMLCanvasElement, body?: HTMLCanvasElement | null, propeller?: HTMLCanvasElement | null) {
    this.sprite = sprite;
    this.bodySprite = body || null;
    this.propellerSprite = propeller || null;
    this.staticFrameKey = '';
  }

  resume() {
    this.previousPhase = '';
    this.plane.visible = false;
    this.exit = null;
    this.cruiseStartedAt = null;
    this.staticFrameKey = '';
  }

  resize(width: number, height: number, pixelRatio: number, mobile = width <= 600) {
    // Keep wide, high-DPI laptop canvases within a practical raster budget.
    const rasterRatio = Math.sqrt(2_000_000 / Math.max(1, width * height));
    const dpr = Math.min(2, pixelRatio || 1, Math.max(1, rasterRatio));
    if (width === this.width && height === this.height && dpr === this.dpr && mobile === this.mobile) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.mobile = mobile;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.background.width = this.canvas.width;
    this.background.height = this.canvas.height;
    this.glow.width = this.canvas.width;
    this.glow.height = this.canvas.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.backgroundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.glowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.glowKey = '';
    this.backgroundKey = '';
    this.staticFrameKey = '';
  }

  render(frame: FlightFrame, now: number): boolean {
    if (!this.width || !this.height) return false;
    if (!verifyPlatformEnvironment()) {
      this.ctx.fillStyle = '#0f172a';
      this.ctx.fillRect(0, 0, this.width, this.height);
      return false;
    }
    const started = performance.now();
    const { phase, multiplier: mult } = frame;
    const w = this.width;
    const h = this.height;
    const mobile = this.mobile;
    const phoneScale = Math.min(1, w / 560);
    const scale = mobile ? 0.8 * phoneScale : 1;
    if (frame.roomId !== this.previousRoom) {
      this.previousPhase = '';
      this.plane.visible = false;
      this.exit = null;
      this.cruiseStartedAt = null;
      this.previousRoom = frame.roomId;
      this.staticFrameKey = '';
    }
    if (phase !== this.previousPhase) {
      if (phase === 'RUNNING') {
        this.runningStartedAt = now;
        this.cruiseStartedAt = null;
        this.exit = null;
      } else if (phase === 'CRASHED') {
        this.rayAngle = 1.5 * Math.PI / 180;
        this.exit = this.plane.visible && !frame.frozen
          ? { startedAt: now, x: this.plane.x, y: this.plane.y } : null;
      } else {
        this.exit = null;
        this.rayAngle = 0;
      }
      this.previousPhase = phase;
      this.staticFrameKey = '';
    }

    const takeoff = frame.takeoff || (phase === 'RUNNING' && mult <= 1.005);
    if (takeoff || phase === 'WAITING') this.rayAngle = 0;
    else if (phase === 'RUNNING') {
      const launch = Math.min(1, Math.max(0, mult - 1));
      const cruise = Math.min(1, Math.max(0, (mult - 2) / 4.1));
      // Cache small ray phase changes instead of repainting every wedge at 60Hz.
      this.rayAngle = Math.round((-2.25 * launch + 1.075 * cruise) / 0.05) * 0.05 * Math.PI / 180;
    }
    const exiting = phase === 'CRASHED' && this.exit !== null && now - this.exit.startedAt < 230;
    const spinning = frame.animate !== false && Boolean(this.bodySprite && this.propellerSprite) && (phase !== 'CRASHED' || exiting);
    const staticFrame = !spinning && (frame.frozen || phase === 'WAITING' || (phase === 'CRASHED' && !exiting));
    const theme = phase === 'RUNNING' && !takeoff ? ((frame.themeMultiplier ?? mult) < 2 ? 'blue' : 'purple') : 'none';
    const staticKey = `${phase}:${takeoff}:${mult}:${theme}:${w}:${h}`;
    if (staticFrame && this.staticFrameKey === staticKey) return false;
    this.staticFrameKey = staticFrame ? staticKey : '';
    this.drawBackground(theme, phase === 'WAITING');
    const rotorTime = frame.animate === false ? 0 : now;

    if (phase === 'CRASHED') {
      // The graph is removed immediately. Only the intact aircraft exits,
      // then the cached black/grey ray background remains for the result.
      if (exiting && this.exit) {
        const t = Math.min(1, (now - this.exit.startedAt) / 230);
        const ease = 1 - (1 - t) * (1 - t);
        this.drawPlane(
          this.exit.x + (w + 110 * scale - this.exit.x) * ease,
          this.exit.y - h * 0.45 * ease,
          scale,
          rotorTime,
        );
      } else {
        this.plane.visible = false;
        this.exit = null;
      }
    } else if (takeoff || phase === 'WAITING') {
      this.plane = { x: 81 * scale, y: h - 42 * scale, visible: phase === 'RUNNING' };
      this.drawPlane(this.plane.x, this.plane.y, scale, rotorTime);
    } else {
      const growth = Math.min(1, Math.max(0, mult - 1));
      const launch = Math.min(1, Math.max(0, (mult - 1) / 0.30));
      let launchEase = launch * launch * (3 - 2 * launch);
      const settle = Math.min(1, Math.max(0, (mult - 2) / 0.7));
      const cruiseEase = settle * settle * (3 - 2 * settle);
      // Blend from the parked attachment rather than clamping it in place.
      // This keeps the first centimetres of takeoff moving continuously.
      let endX = 23 * scale * (1 - launchEase) + Math.max(0, w - 139 * scale)
        * ((mobile ? 0.900 : 0.920) * Math.pow(growth, 0.385) + (mobile ? 0.016 : 0.042) * cruiseEase) * launchEase;
      let rise = h * (0.711 * Math.pow(growth, 0.30) * (mobile ? 1.2 : 1) * (1 - cruiseEase) + (mobile ? 0.595 : 0.427) * cruiseEase) * launchEase;
      const hoverRamp = Math.min(1, Math.max(0, (mult - 1.25) / 1));
      const hoverFade = Math.min(1, Math.max(0, (mult - 1.8) / 0.2));
      let hover = frame.frozen ? 0
        : Math.sin((frame.flightElapsedMs ?? now - this.runningStartedAt) * Math.PI * 2 / 7990)
          * h * 0.085 * hoverRamp * (1 - hoverFade * hoverFade * (3 - 2 * hoverFade));
      if (!frame.frozen) {
        if (mobile && mult < 2) {
          // Match the video's gradual climb using confirmed engine progress.
          // The continuous render multiplier keeps movement smooth between ticks.
          const progress = Math.min(1, Math.max(0, Math.log(mult) / Math.log(2)));
          launchEase = progress * progress * (3 - 2 * progress);
          endX = 23 * scale * (1 - launchEase) + w * 0.668 * launchEase;
          rise = h * 0.815 * launchEase;
          hover = 0;
        } else if (mult >= 2) {
          if (this.cruiseStartedAt === null) {
            // Anchor once to this server round, including when joining midflight.
            const elapsed = frame.flightElapsedMs ?? now - this.runningStartedAt;
            const cruiseAge = elapsed * Math.max(0, 1 - Math.log(2) / Math.log(mult));
            this.cruiseStartedAt = now - cruiseAge;
          }
          const cruiseAge = Math.max(0, now - this.cruiseStartedAt);
          const angle = cruiseAge * Math.PI * 2 / 7990;
          // Measured from the supplied video: a smooth eight-second diagonal
          // drift, with a longer low arc and a quicker return toward the top.
          const horizontal = 0.72795 - 0.04799 * Math.cos(angle) + 0.00830 * Math.sin(angle)
            - 0.01198 * Math.cos(2 * angle) + 0.01010 * Math.sin(2 * angle);
          const blendProgress = Math.min(1, cruiseAge / 1200);
          const blend = blendProgress * blendProgress * (3 - 2 * blendProgress);
          if (mobile) {
            endX = w * horizontal;
            rise = h * (0.815 * (1 - blend) + (2.52091 - 2.58618 * horizontal) * blend);
          } else {
            endX = (0.920 * (w - 139 * scale)) * (1 - blend)
              + w * (0.868 + (horizontal - 0.72795) * 0.60) * blend;
            rise = h * (0.711 * (1 - blend) + (0.427 - (horizontal - 0.72795) * 1.8) * blend);
          }
          hover = 0;
        }
      }
      const startY = h - 2;
      let endY = Math.max(78 * scale + 6, Math.min(h - 2, startY - 3 * scale * (1 - launchEase) - rise + hover));
      if (frame.animate === false && this.plane.visible) {
        endX = this.plane.x - 58 * scale;
        endY = this.plane.y + 37 * scale;
      }
      this.ctx.beginPath();
      this.ctx.moveTo(0, startY);
      this.ctx.quadraticCurveTo(endX / 2, startY, endX, endY);
      this.ctx.lineTo(endX, startY);
      this.ctx.closePath();
      this.ctx.fillStyle = 'rgba(198, 2, 26, 0.527)';
      this.ctx.fill();
      this.ctx.beginPath();
      this.ctx.moveTo(0, startY);
      this.ctx.quadraticCurveTo(endX / 2, startY, endX, endY);
      this.ctx.strokeStyle = '#f00b3e';
      this.ctx.lineWidth = mobile ? 4 * phoneScale : 4;
      this.ctx.lineCap = 'round';
      this.ctx.stroke();
      this.plane = { x: endX + 58 * scale, y: endY - 37 * scale, visible: true };
      this.drawPlane(this.plane.x, this.plane.y, scale, rotorTime);
    }
    this.lastRenderMs = performance.now() - started;
    return true;
  }

  private drawPlane(x: number, y: number, scale: number, now: number) {
    if (!this.bodySprite || !this.propellerSprite) {
      if (this.sprite) this.ctx.drawImage(this.sprite, x - 81 * scale, y - 39 * scale, 162 * scale, 78 * scale);
      return;
    }
    this.ctx.drawImage(this.bodySprite, x - 81 * scale, y - 39 * scale, 162 * scale, 78 * scale);
    const phase = now * 0.028;
    // A side-on propeller spins in its own tilted plane. Only the original
    // blade artwork changes projection; the fuselage and shaft stay intact.
    // Integrate three blade positions like a camera exposure. The apparent
    // diameter stays at least 86% full, as in the reference, instead of blinking
    // out at a quarter turn. The nose and shaft remain in the fixed body asset.
    let totalWeight = 0;
    for (let sample = -1; sample <= 1; sample++) {
      totalWeight += Math.pow(Math.abs(Math.cos(phase + sample * Math.PI / 3)), 8);
    }
    for (let sample = -1; sample <= 1; sample++) {
      const projection = Math.cos(phase + sample * Math.PI / 3);
      this.ctx.save();
      this.ctx.globalAlpha = Math.pow(Math.abs(projection), 8) / totalWeight;
      this.ctx.translate(x + 71 * scale, y);
      this.ctx.rotate(-0.205);
      this.ctx.scale(scale, scale * projection);
      this.ctx.rotate(0.205);
      this.ctx.drawImage(this.propellerSprite, -152, -39, 162, 78);
      this.ctx.restore();
    }
  }

  private drawBackground(theme: 'none' | 'blue' | 'purple', parked = false) {
    const w = this.width;
    const h = this.height;
    const key = `${theme}:${this.rayAngle}:${w}:${h}:${this.dpr}`;
    const changed = key !== this.backgroundKey;
    if (changed) {
      const ctx = this.backgroundCtx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.translate(0, h);
      ctx.rotate(this.rayAngle);
      const radius = Math.hypot(w, h) * 1.1;
      // Only the visible quadrant is needed, with one wedge of overscan.
      for (let index = 26; index <= 36; index++) {
        const start = (index * 10 + 5.75) * Math.PI / 180;
        const end = start + 5 * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(start) * radius, Math.sin(start) * radius);
        ctx.lineTo(Math.cos(end) * radius, Math.sin(end) * radius);
        ctx.closePath();
        ctx.fillStyle = '#0c0c0c';
        ctx.fill();
      }
      ctx.restore();
      if (theme !== 'none') {
        const glowKey = `${theme}:${w}:${h}:${this.dpr}`;
        if (this.glowKey !== glowKey) {
          const glowCtx = this.glowCtx;
          glowCtx.clearRect(0, 0, w, h);
          glowCtx.save();
          glowCtx.translate(w * 0.5, h * 0.5);
          glowCtx.scale(w * (theme === 'purple' ? 0.1793 : 0.1778), h * 0.1665);
          const gradient = glowCtx.createRadialGradient(0, 0, 0, 0, 0, 4);
          const color = theme === 'purple' ? '145, 62, 248' : '53, 180, 255';
          const peak = theme === 'purple' ? 0.561 : 0.564;
          for (let step = 0; step <= 32; step++) {
            const distance = step / 8;
            gradient.addColorStop(step / 32, `rgba(${color}, ${step === 32 ? 0 : peak * Math.exp(-distance * distance / 2)})`);
          }
          glowCtx.fillStyle = gradient;
          glowCtx.fillRect(-4, -4, 8, 8);
          glowCtx.restore();
          this.glowKey = glowKey;
        }
        ctx.drawImage(this.glow, 0, 0, w, h);
      }
      this.backgroundKey = key;
    }
    if (parked && !changed) {
      // Refresh just the parked plane's area; the waiting backdrop is cached.
      const scale = this.mobile ? 0.8 * Math.min(1, w / 560) : 1;
      const top = Math.max(0, h - 84 * scale);
      const width = Math.min(w, 170 * scale);
      const height = h - top;
      this.ctx.drawImage(this.background, 0, top * this.dpr, width * this.dpr, height * this.dpr, 0, top, width, height);
    } else this.ctx.drawImage(this.background, 0, 0, w, h);
  }
}
