/**
 * Phaser board scene.
 *
 * The server owns the board; this scene only renders it and plays effects. It
 * reconciles on every authoritative snapshot and defers removals while a match
 * animation is running so the two never fight each other.
 */

import { TILE_TYPES } from '/shared/tiles.js';
import { computeBoardLayout, labelBoxes, labelFontSize } from '/shared/boardLayout.js';

const Phaser = window.Phaser;
const BaseScene = Phaser ? Phaser.Scene : class {};

const GLYPH_FONT =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif';

const label = (c, r) => `${String.fromCharCode(65 + c - 1)}${r}`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export class BoardScene extends BaseScene {
  constructor() {
    super('BoardScene');
    this.tiles = new Map();
    this.ready = false;
    this.queuedState = null;
    this.selected = [];
    this.cols = 6;
    this.rows = 6;
    this.cell = 100;
    this.originX = 0;
    this.originY = 0;
    this.layout = null;
    this.labelLayer = null;
    this.needsRebuild = false;
    this.speed = 1;
    this.onSubmit = null;
  }

  create() {
    this.tiles = new Map();
    this.buildTextures();
    this.layoutFor(this.cols, this.rows);
    this.selectionGfx = this.add.graphics().setDepth(40);
    this.ready = true;
    if (this.queuedState) {
      const state = this.queuedState;
      this.queuedState = null;
      this.applyState(state);
    }
  }

  // ------------------------------------------------------------------ textures

  buildTextures() {
    for (const type of TILE_TYPES) {
      const key = `tile-${type.id}`;
      if (this.textures.exists(key)) continue;
      const size = 160;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      ctx.clearRect(0, 0, size, size);

      // soft drop shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 10;
      roundRect(ctx, 12, 12, size - 24, size - 24, 34);
      ctx.fillStyle = type.color2;
      ctx.fill();
      ctx.restore();

      // gradient face
      const grad = ctx.createLinearGradient(10, 10, size - 10, size - 10);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.12, type.color);
      grad.addColorStop(0.7, type.color);
      grad.addColorStop(1, type.color2);
      roundRect(ctx, 12, 8, size - 24, size - 24, 34);
      ctx.fillStyle = grad;
      ctx.fill();

      // glossy top
      const gloss = ctx.createLinearGradient(0, 12, 0, 70);
      gloss.addColorStop(0, 'rgba(255,255,255,0.7)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      roundRect(ctx, 26, 18, size - 52, 46, 22);
      ctx.fillStyle = gloss;
      ctx.fill();

      // inner border
      roundRect(ctx, 14, 10, size - 28, size - 28, 32);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.stroke();

      // bottom lip
      roundRect(ctx, 16, size - 30, size - 32, 14, 7);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fill();

      this.textures.addCanvas(key, canvas);
    }
  }

  // ------------------------------------------------------------------- layout

  layoutFor(cols, rows) {
    this.layout = computeBoardLayout({
      width: this.scale.width,
      height: this.scale.height,
      cols,
      rows,
    });
    this.cell = this.layout.cell;
    this.originX = this.layout.originX;
    this.originY = this.layout.originY;
    this.drawCoordinates();
  }

  centerOf(c, r) {
    if (this.layout) return this.layout.tileCenter(c, r);
    return {
      x: this.originX + (c + 0.5) * this.cell,
      y: this.originY + (r + 0.5) * this.cell,
    };
  }

  /**
   * Coordinate headers: letters above the columns, numbers left of the rows.
   * They live in the routing ring, one cell outside the tiles, and use the same
   * geometry as centerOf(), so a label always points at its real tile.
   */
  drawCoordinates() {
    if (!this.layout) return;
    if (this.labelLayer) this.labelLayer.destroy();

    const layer = this.add.container(0, 0).setDepth(6);
    const graphics = this.add.graphics();
    layer.add(graphics);

    const boxes = labelBoxes(this.layout);
    const fontSize = labelFontSize(this.layout);
    const radius = Math.max(6, this.layout.cell * 0.16);

    for (const box of [...boxes.columns, ...boxes.rows]) {
      graphics.fillStyle(0x0a1430, 0.8);
      graphics.fillRoundedRect(box.left, box.top, box.width, box.height, radius);
      graphics.lineStyle(2, 0x5ce1ff, 0.45);
      graphics.strokeRoundedRect(box.left, box.top, box.width, box.height, radius);

      const text = this.add
        .text(box.x, box.y, box.text, {
          fontFamily: '"Trebuchet MS", sans-serif',
          fontSize: `${fontSize}px`,
          color: '#ffe14d',
          fontStyle: 'bold',
        })
        .setOrigin(0.5);
      text.setShadow(0, 2, 'rgba(0,0,0,0.8)', 4);
      layer.add(text);
    }

    this.labelLayer = layer;
  }

  // -------------------------------------------------------------------- tiles

  createTile(c, r, type, { delay = 0, pop = true } = {}) {
    const key = `${c}:${r}`;
    const size = this.cell * 0.86;
    const pos = this.centerOf(c, r);
    const container = this.add.container(pos.x, pos.y);
    container.setDepth(10);

    const image = this.add.image(0, 0, `tile-${type % TILE_TYPES.length}`).setDisplaySize(size, size);
    const glyph = this.add
      .text(0, size * 0.02, TILE_TYPES[type % TILE_TYPES.length].glyph, {
        fontFamily: GLYPH_FONT,
        fontSize: `${Math.round(size * 0.5)}px`,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    glyph.setShadow(0, 3, 'rgba(0,0,0,0.4)', 3);

    container.add([image, glyph]);
    container.setSize(size, size);
    container.setInteractive(
      new Phaser.Geom.Rectangle(-size / 2, -size / 2, size, size),
      Phaser.Geom.Rectangle.Contains
    );
    container.on('pointerdown', () => this.onTileClick(c, r));
    container.on('pointerover', () => {
      if (!this.tiles.has(key)) return;
      this.input.setDefaultCursor('pointer');
      this.tweens.add({ targets: container, scale: 1.06, duration: 110 });
    });
    container.on('pointerout', () => {
      this.input.setDefaultCursor('default');
      if (!this.tiles.has(key) || container.removing) return;
      this.tweens.add({ targets: container, scale: 1, duration: 110 });
    });

    if (pop) {
      container.setScale(0.2);
      container.setAlpha(0);
      this.tweens.add({
        targets: container,
        scale: 1,
        alpha: 1,
        delay,
        duration: 300 / this.speed,
        ease: 'Back.easeOut',
      });
      if (delay) container.setAlpha(0);
    }

    const tile = { container, type, c, r, size, removing: false };
    this.tiles.set(key, tile);
    return tile;
  }

  markRemoving(key) {
    const tile = this.tiles.get(key);
    if (!tile) return null;
    tile.removing = true;
    this.tiles.delete(key);
    return tile;
  }

  popTile(key, { stagger = 0, points = 0, color = '#ffe14d' } = {}) {
    const tile = this.markRemoving(key);
    if (!tile) return;
    const { container, size } = tile;

    if (points > 0) {
      const text = this.add
        .text(container.x, container.y, `+${points}`, {
          fontFamily: '"Trebuchet MS", sans-serif',
          fontSize: `${Math.round(this.cell * 0.34)}px`,
          color,
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setDepth(60);
      text.setShadow(0, 3, 'rgba(0,0,0,0.6)', 6);
      this.tweens.add({
        targets: text,
        y: container.y - this.cell * 0.7,
        alpha: 0,
        duration: 850 / this.speed,
        ease: 'Cubic.easeOut',
        onComplete: () => text.destroy(),
      });
    }

    const burst = this.add.circle(container.x, container.y, size * 0.28, 0xffffff, 0.85).setDepth(30);
    this.tweens.add({
      targets: burst,
      scale: 2.4,
      alpha: 0,
      duration: 380 / this.speed,
      onComplete: () => burst.destroy(),
    });

    this.time.delayedCall(stagger, () => {
      this.tweens.add({
        targets: container,
        scale: 1.22,
        duration: 90 / this.speed,
        ease: 'Quad.easeOut',
        onComplete: () => {
          this.tweens.add({
            targets: container,
            scale: 0,
            alpha: 0,
            duration: 190 / this.speed,
            ease: 'Back.easeIn',
            onComplete: () => container.destroy(),
          });
        },
      });
    });
  }

  removeTileInstant(key) {
    const tile = this.markRemoving(key);
    if (!tile) return;
    this.tweens.add({
      targets: tile.container,
      alpha: 0,
      scale: 0.6,
      duration: 140,
      onComplete: () => tile.container.destroy(),
    });
  }

  destroyAll() {
    for (const tile of this.tiles.values()) tile.container.destroy();
    this.tiles.clear();
  }

  // ------------------------------------------------------------------- effects

  drawPath(points, { color = 0xffe14d, duration = 620 } = {}) {
    if (!Array.isArray(points) || points.length < 2) return;
    const graphics = this.add.graphics().setDepth(50);
    const pts = points.map((point) => this.centerOf(point.c, point.r));

    graphics.lineStyle(this.cell * 0.16, color, 0.25);
    graphics.beginPath();
    graphics.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) graphics.lineTo(pts[i].x, pts[i].y);
    graphics.strokePath();

    graphics.lineStyle(this.cell * 0.055, color, 0.95);
    graphics.beginPath();
    graphics.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) graphics.lineTo(pts[i].x, pts[i].y);
    graphics.strokePath();

    for (const point of [pts[0], pts[pts.length - 1]]) {
      graphics.fillStyle(0xffffff, 0.85);
      graphics.fillCircle(point.x, point.y, this.cell * 0.06);
    }

    this.tweens.add({
      targets: graphics,
      alpha: 0,
      delay: 180,
      duration: duration / this.speed,
      onComplete: () => graphics.destroy(),
    });
  }

  ringAround(c, r, { color = 0xffe14d, grow = 1.35, duration = 700 } = {}) {
    const pos = this.centerOf(c, r);
    const graphics = this.add.graphics().setDepth(45);
    const size = this.cell * 0.9;
    graphics.lineStyle(7, color, 0.95);
    graphics.strokeRoundedRect(-size / 2, -size / 2, size, size, 18);
    graphics.setPosition(pos.x, pos.y);
    this.tweens.add({
      targets: graphics,
      scale: grow,
      alpha: 0,
      duration: duration / this.speed,
      ease: 'Cubic.easeOut',
      onComplete: () => graphics.destroy(),
    });
  }

  playMatch(fx) {
    const aKey = `${fx.a.c}:${fx.a.r}`;
    const bKey = `${fx.b.c}:${fx.b.r}`;
    if (fx.path) this.drawPath(fx.path, { color: fx.auto ? 0x9ad7ff : 0xffe14d });
    this.time.delayedCall(90, () => {
      this.popTile(aKey, { points: fx.points || 0 });
      this.popTile(bKey);
    });
    this.ringAround(fx.a.c, fx.a.r, { color: 0xffe14d });
    this.ringAround(fx.b.c, fx.b.r, { color: 0xffe14d });
  }

  playHint(fx) {
    if (fx.path) this.drawPath(fx.path, { color: 0x5ce1ff, duration: 1100 });
    this.ringAround(fx.a.c, fx.a.r, { color: 0x5ce1ff, grow: 1.5, duration: 1100 });
    this.ringAround(fx.b.c, fx.b.r, { color: 0x5ce1ff, grow: 1.5, duration: 1100 });
  }

  playReveal(fx) {
    if (fx.path) this.drawPath(fx.path, { color: 0xff7ab8, duration: 1300 });
    for (const cell of [fx.a, fx.b]) {
      this.ringAround(cell.c, cell.r, { color: 0xff7ab8, grow: 1.7, duration: 1300 });
      const pos = this.centerOf(cell.c, cell.r);
      for (let i = 0; i < 5; i += 1) {
        const spark = this.add.circle(pos.x, pos.y, 6, 0xfff2b0, 0.95).setDepth(46);
        const angle = (Math.PI * 2 * i) / 5 + Math.random();
        this.tweens.add({
          targets: spark,
          x: pos.x + Math.cos(angle) * this.cell,
          y: pos.y + Math.sin(angle) * this.cell,
          alpha: 0,
          duration: 700,
          onComplete: () => spark.destroy(),
        });
      }
    }
  }

  playAttempt(fx) {
    this.clearSelection();
    const color = fx.ok ? 0x6bf0a0 : 0xff6b6b;
    for (const cell of [fx.a, fx.b]) {
      const key = `${cell.c}:${cell.r}`;
      const tile = this.tiles.get(key);
      if (!tile) continue;
      this.ringAround(cell.c, cell.r, { color, grow: 1.2, duration: 420 });
      if (!fx.ok) {
        const baseX = this.centerOf(cell.c, cell.r).x;
        this.tweens.add({
          targets: tile.container,
          x: { from: baseX - 7, to: baseX + 7 },
          duration: 55,
          yoyo: true,
          repeat: 3,
          onComplete: () => {
            if (tile.container && tile.container.active) tile.container.x = baseX;
          },
        });
      }
    }
  }

  playClearHalf(fx) {
    (fx.pairs || []).forEach((pair, index) => {
      this.time.delayedCall(index * 45, () => {
        this.drawPath(pair.path, { color: 0xff7ab8, duration: 460 });
        this.popTile(`${pair.a.c}:${pair.a.r}`);
        this.popTile(`${pair.b.c}:${pair.b.r}`);
      });
    });
  }

  playClearAll(fx) {
    const cells = fx.cells || [];
    cells.forEach((cell, index) => {
      this.time.delayedCall(index * 26, () => this.popTile(`${cell.c}:${cell.r}`, { color: '#8ef0ff' }));
    });
  }

  shakeBoard() {
    const cam = this.cameras.main;
    this.tweens.add({
      targets: cam,
      x: { from: -8, to: 8 },
      duration: 50,
      yoyo: true,
      repeat: 6,
      onComplete: () => {
        cam.x = 0;
      },
    });
  }

  // -------------------------------------------------------------------- state

  applyState(state) {
    if (!state || !state.grid) return;
    if (!this.ready) {
      this.queuedState = state;
      return;
    }

    const layoutChanged = state.cols !== this.cols || state.rows !== this.rows;
    if (layoutChanged) {
      this.cols = state.cols;
      this.rows = state.rows;
      this.layoutFor(this.cols, this.rows);
      this.destroyAll();
      this.needsRebuild = false;
    }

    if (this.needsRebuild) {
      this.needsRebuild = false;
      this.destroyAll();
      this.rebuild(state);
      return;
    }

    const seen = new Set();
    for (let r = 1; r <= state.rows; r += 1) {
      for (let c = 1; c <= state.cols; c += 1) {
        const type = state.grid[r][c];
        const key = `${c}:${r}`;
        seen.add(key);
        const tile = this.tiles.get(key);
        if (type === null || type === undefined) {
          if (tile && !tile.removing) this.removeTileInstant(key);
        } else if (!tile) {
          this.createTile(c, r, type, { delay: 0 });
        } else if (tile.type !== type) {
          this.removeTileInstant(key);
          this.createTile(c, r, type);
        }
      }
    }

    for (const key of [...this.tiles.keys()]) {
      if (!seen.has(key)) this.removeTileInstant(key);
    }
  }

  rebuild(state) {
    this.tiles.clear();
    for (let r = 1; r <= state.rows; r += 1) {
      for (let c = 1; c <= state.cols; c += 1) {
        const type = state.grid[r][c];
        if (type === null || type === undefined) continue;
        this.createTile(c, r, type, { delay: Math.min(420, (c + r) * 22) });
      }
    }
  }

  handleFx(fx) {
    if (!fx || !this.ready) return;
    switch (fx.kind) {
      case 'match':
        this.playMatch(fx);
        break;
      case 'attempt':
        this.playAttempt(fx);
        break;
      case 'hint':
        this.playHint(fx);
        break;
      case 'reveal':
        this.playReveal(fx);
        break;
      case 'clearHalf':
        this.playClearHalf(fx);
        break;
      case 'clearAll':
        this.playClearAll(fx);
        break;
      case 'shuffle':
        this.needsRebuild = true;
        this.clearSelection();
        break;
      case 'newLevel':
        this.needsRebuild = true;
        this.clearSelection();
        break;
      case 'levelComplete':
        this.drawLevelSparkles();
        break;
      case 'gameover':
        this.shakeBoard();
        break;
      default:
        break;
    }
  }

  drawLevelSparkles() {
    for (let i = 0; i < 18; i += 1) {
      const x = this.originX + Math.random() * (this.cols + 2) * this.cell;
      const y = this.originY + Math.random() * (this.rows + 2) * this.cell;
      const star = this.add.text(x, y, '✨', { fontSize: `${Math.round(this.cell * 0.4)}px` }).setOrigin(0.5).setDepth(55);
      this.tweens.add({
        targets: star,
        y: y - this.cell * 1.2,
        alpha: 0,
        duration: 900 + Math.random() * 500,
        onComplete: () => star.destroy(),
      });
    }
  }

  // ----------------------------------------------------------------- selection

  onTileClick(c, r) {
    const key = `${c}:${r}`;
    if (!this.tiles.has(key)) return;
    const existing = this.selected.findIndex((cell) => cell.c === c && cell.r === r);
    if (existing !== -1) {
      this.selected.splice(existing, 1);
      this.drawSelection();
      return;
    }
    this.selected.push({ c, r });
    if (this.selected.length > 2) this.selected.shift();
    this.drawSelection();
    if (this.selected.length === 2) {
      const [a, b] = this.selected;
      this.selected = [];
      this.drawSelection();
      this.onSubmit?.(label(a.c, a.r), label(b.c, b.r));
    }
  }

  drawSelection() {
    if (!this.selectionGfx) return;
    this.selectionGfx.clear();
    const size = this.cell * 0.9;
    for (const cell of this.selected) {
      const pos = this.centerOf(cell.c, cell.r);
      this.selectionGfx.lineStyle(7, 0x5ce1ff, 0.95);
      this.selectionGfx.strokeRoundedRect(pos.x - size / 2, pos.y - size / 2, size, size, 18);
      this.selectionGfx.lineStyle(3, 0xffffff, 0.55);
      this.selectionGfx.strokeRoundedRect(pos.x - size / 2 + 6, pos.y - size / 2 + 6, size - 12, size - 12, 14);
    }
  }

  clearSelection() {
    this.selected = [];
    this.drawSelection();
  }

  setSpeed(speed) {
    this.speed = Math.max(0.25, Number(speed) || 1);
  }
}
