// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of EmbPattern.py (the parts the PES/DST/JEF/EXP/VP3 readers, writers and encoder use).
// Python operator overloads, file-path I/O helpers, matrix transform and the Python-only
// list/complex input forms of add_block are intentionally not ported.
import {
  COLOR_BREAK,
  COLOR_CHANGE,
  COMMAND_MASK,
  END,
  FRAME_EJECT,
  JUMP,
  MATRIX_ROTATE,
  MATRIX_SCALE,
  MATRIX_TRANSLATE,
  NEEDLE_AT,
  NEEDLE_SET,
  NO_COMMAND,
  SEQUENCE_BREAK,
  SEQUIN_EJECT,
  SEQUIN_MODE,
  SEW_TO,
  STITCH,
  STITCH_BREAK,
  STOP,
  TRIM,
} from "./constants";
import { Transcoder } from "./encoder";
import { encodeThreadChange, decodeEmbroideryCommand } from "./functions";
import type { WriterSettings } from "./settings";
import { EmbThread, FILLER_COLORS, pyRound, threadSetOrder, type ThreadInput } from "./thread";

/** A stitch is a mutable [x, y, command] triple, exactly as in pystitch. */
export type Stitch = [x: number, y: number, cmd: number];

export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** Encoder settings (the `settings` dict pystitch passes to get_normalized_pattern). */
export type EncodeSettings = WriterSettings;

export type StitchBlock = [stitches: Stitch[], thread: EmbThread];
export type ColorBlock = [stitches: Stitch[], thread: EmbThread];

/** Thrown by a reader whose `maxStitches` limit was exceeded (an API-layer option; pystitch has no such limit). */
export class StitchLimitError extends Error {
  constructor(readonly limit: number) {
    super(`More than ${limit} stitches.`);
    this.name = "StitchLimitError";
  }
}

export class EmbPattern {
  /** Optional reader safety limit: adding a stitch beyond it throws StitchLimitError. Unlimited by default. */
  maxStitches: number | null = null;
  stitches: Stitch[] = [];
  threads: EmbThread[] = []; // pystitch: threadlist
  extras: Record<string, unknown> = {};
  // filename, name, category, author, keywords, comments, are typical
  private _previousX = 0;
  private _previousY = 0;

  constructor(source?: EmbPattern) {
    if (source !== undefined) {
      if (!(source instanceof EmbPattern)) throw new TypeError("expected first argument to be an EmbPattern");
      this.stitches = source.stitches.slice();
      this.threads = source.threads.slice();
      Object.assign(this.extras, source.extras);
      this._previousX = source._previousX;
      this._previousY = source._previousY;
    }
  }

  /** __len__ */
  get length(): number {
    return this.stitches.length;
  }

  copy(): EmbPattern {
    return new EmbPattern(this);
  }

  clear(): void {
    this.stitches = [];
    this.threads = [];
    this.extras = {};
    this._previousX = 0;
    this._previousY = 0;
  }

  move(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(JUMP, dx, dy);
    else this.insertStitchRelative(position, JUMP, dx, dy);
  }

  moveAbs(x: number, y: number, position?: number | null): void {
    if (position == null) this.addStitchAbsolute(JUMP, x, y);
    else this.insert(position, JUMP, x, y);
  }

  stitch(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(STITCH, dx, dy);
    else this.insertStitchRelative(position, STITCH, dx, dy);
  }

  stitchAbs(x: number, y: number, position?: number | null): void {
    if (position == null) this.addStitchAbsolute(STITCH, x, y);
    else this.insert(position, STITCH, x, y);
  }

  stop(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(STOP, dx, dy);
    else this.insertStitchRelative(position, STOP, dx, dy);
  }

  trim(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(TRIM, dx, dy);
    else this.insertStitchRelative(position, TRIM, dx, dy);
  }

  colorChange(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(COLOR_CHANGE, dx, dy);
    else this.insertStitchRelative(position, COLOR_CHANGE, dx, dy);
  }

  needleChange(needle = 0, dx = 0, dy = 0, position?: number | null): void {
    const cmd = encodeThreadChange(NEEDLE_SET, null, needle);
    if (position == null) this.addStitchRelative(cmd, dx, dy);
    else this.insertStitchRelative(position, cmd, dx, dy);
  }

  sequinEject(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(SEQUIN_EJECT, dx, dy);
    else this.insertStitchRelative(position, SEQUIN_EJECT, dx, dy);
  }

  sequinMode(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(SEQUIN_MODE, dx, dy);
    else this.insertStitchRelative(position, SEQUIN_MODE, dx, dy);
  }

  end(dx = 0, dy = 0, position?: number | null): void {
    if (position == null) this.addStitchRelative(END, dx, dy);
    else this.insertStitchRelative(position, END, dx, dy);
  }

  /** add_thread. Note: this has no effect on stitching and can be done at any point. */
  addThread(thread: ThreadInput): void {
    if (thread instanceof EmbThread) {
      this.threads.push(thread);
    } else {
      const threadObject = new EmbThread();
      threadObject.set(thread);
      this.threads.push(threadObject);
    }
  }

  /** metadata: no effect on stitching. */
  metadata(name: string, data: unknown): void {
    this.extras[name] = data;
  }

  getMetadata(name: string, defaultValue: unknown = null): unknown {
    return Object.prototype.hasOwnProperty.call(this.extras, name) ? this.extras[name] : defaultValue;
  }

  /** bounds: [minX, minY, maxX, maxY]. An empty pattern gives [inf, inf, -inf, -inf], as in pystitch. */
  bounds(): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stitch of this.stitches) {
      if (stitch[0] > maxX) maxX = stitch[0];
      if (stitch[0] < minX) minX = stitch[0];
      if (stitch[1] > maxY) maxY = stitch[1];
      if (stitch[1] < minY) minY = stitch[1];
    }
    return [minX, minY, maxX, maxY];
  }

  extends(): Bounds {
    return this.bounds();
  }

  extents(): Bounds {
    return this.bounds();
  }

  countStitchCommands(command: number): number {
    let count = 0;
    for (const stitch of this.stitches) {
      if ((stitch[2] & COMMAND_MASK) === command) count++;
    }
    return count;
  }

  countColorChanges(): number {
    return this.countStitchCommands(COLOR_CHANGE);
  }

  countNeedleSets(): number {
    return this.countStitchCommands(NEEDLE_SET);
  }

  countStitches(): number {
    return this.stitches.length;
  }

  countThreads(): number {
    return this.threads.length;
  }

  /**
   * get_random_thread. Deliberate, documented difference from pystitch (random.getrandbits(24)):
   * the colour is FILLER_COLORS[index % length] so output is deterministic.
   */
  static getRandomThread(index = 0): EmbThread {
    const thread = new EmbThread();
    thread.color = FILLER_COLORS[index % FILLER_COLORS.length];
    thread.description = "Random";
    return thread;
  }

  getThreadOrFiller(index: number): EmbThread {
    if (this.threads.length <= index) return EmbPattern.getRandomThread(index);
    return this.threads[index];
  }

  getThread(index: number): EmbThread {
    return this.threads[index];
  }

  *getMatchCommands(command: number): Generator<Stitch> {
    for (const stitch of this.stitches) {
      if ((stitch[2] & COMMAND_MASK) === command) yield stitch;
    }
  }

  *getAsStitchblock(): Generator<StitchBlock> {
    let stitchblock: Stitch[] = [];
    let thread = this.getThreadOrFiller(0);
    let threadIndex = 1;
    for (const stitch of this.stitches) {
      const flags = stitch[2] & COMMAND_MASK;
      if (flags === STITCH) {
        stitchblock.push(stitch);
      } else {
        if (stitchblock.length > 0) {
          yield [stitchblock, thread];
          stitchblock = [];
        }
        if (flags === COLOR_CHANGE) {
          thread = this.getThreadOrFiller(threadIndex);
          threadIndex += 1;
        }
      }
    }
    if (stitchblock.length > 0) yield [stitchblock, thread];
  }

  *getAsCommandBlocks(): Generator<Stitch[]> {
    let lastPos = 0;
    let lastCommand = NO_COMMAND;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const command = this.stitches[pos][2] & COMMAND_MASK;
      if (command === lastCommand || lastCommand === NO_COMMAND) {
        lastCommand = command;
        continue;
      }
      lastCommand = command;
      yield this.stitches.slice(lastPos, pos);
      lastPos = pos;
    }
    yield this.stitches.slice(lastPos);
  }

  /**
   * get_as_colorblocks. Colour blocks defined with COLOR_BREAK have the command omitted whereas
   * blocks delimited with COLOR_CHANGE end with the COLOR_CHANGE command, and with NEEDLE_SET the
   * new block begins with the NEEDLE_SET.
   */
  *getAsColorblocks(): Generator<ColorBlock> {
    let threadIndex = 0;
    let colorblockStart = 0;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const command = this.stitches[pos][2] & COMMAND_MASK;
      if (command === COLOR_BREAK) {
        if (colorblockStart !== pos) {
          const thread = this.getThreadOrFiller(threadIndex);
          threadIndex += 1;
          yield [this.stitches.slice(colorblockStart, pos), thread];
        }
        colorblockStart = pos + 1;
        continue;
      }
      if (command === COLOR_CHANGE) {
        const thread = this.getThreadOrFiller(threadIndex);
        threadIndex += 1;
        yield [this.stitches.slice(colorblockStart, pos + 1), thread];
        colorblockStart = pos + 1;
        continue;
      }
      if (command === NEEDLE_SET && colorblockStart !== pos) {
        const thread = this.getThreadOrFiller(threadIndex);
        threadIndex += 1;
        yield [this.stitches.slice(colorblockStart, pos), thread];
        colorblockStart = pos;
        continue;
      }
    }
    if (colorblockStart !== this.stitches.length) {
      const thread = this.getThreadOrFiller(threadIndex);
      yield [this.stitches.slice(colorblockStart), thread];
    }
  }

  /** get_as_stitches: [pos, x, y, command, thread, needle, order] */
  *getAsStitches(): Generator<[number, number, number, number, number | null, number | null, number | null]> {
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const stitch = this.stitches[pos];
      const [command, thread, needle, order] = decodeEmbroideryCommand(stitch[2]);
      yield [pos, stitch[0], stitch[1], command, thread, needle, order];
    }
  }

  /** get_unique_threadlist: pystitch returns set(threadlist); this is that set's CPython iteration order. */
  getUniqueThreadlist(): EmbThread[] {
    return threadSetOrder(this.threads);
  }

  getSingletonThreadlist(): EmbThread[] {
    const singleton: EmbThread[] = [];
    let lastThread: EmbThread | null = null;
    for (const thread of this.threads) {
      if (lastThread === null || !thread.equals(lastThread)) singleton.push(thread);
      lastThread = thread;
    }
    return singleton;
  }

  moveCenterToOrigin(): void {
    const extends_ = this.bounds();
    const cx = pyRound((extends_[2] + extends_[0]) / 2.0);
    const cy = pyRound((extends_[3] + extends_[1]) / 2.0);
    this.translate(-cx, -cy);
  }

  translate(dx: number, dy: number): void {
    for (const stitch of this.stitches) {
      stitch[0] += dx;
      stitch[1] += dy;
    }
  }

  /** fix_color_count: ensure that there are threads for all colour blocks. */
  fixColorCount(): void {
    let threadIndex = 0;
    let initColor = true;
    for (const stitch of this.stitches) {
      const data = stitch[2] & COMMAND_MASK;
      if (data === STITCH || data === SEW_TO || data === NEEDLE_AT) {
        if (initColor) {
          threadIndex += 1;
          initColor = false;
        }
      } else if (data === COLOR_CHANGE || data === COLOR_BREAK || data === NEEDLE_SET) {
        initColor = true;
      }
    }
    while (this.threads.length < threadIndex) {
      this.addThread(this.getThreadOrFiller(this.threads.length));
    }
  }

  /** add_stitch_absolute (pystitch argument order: cmd, x, y). */
  addStitchAbsolute(cmd: number, x = 0, y = 0): void {
    if (this.maxStitches !== null && this.stitches.length >= this.maxStitches) throw new StitchLimitError(this.maxStitches);
    this.stitches.push([x, y, cmd]);
    this._previousX = x;
    this._previousY = y;
  }

  /** add_stitch_relative: relative to the previous location. */
  addStitchRelative(cmd: number, dx = 0, dy = 0): void {
    const x = this._previousX + dx;
    const y = this._previousY + dy;
    this.addStitchAbsolute(cmd, x, y);
  }

  /**
   * insert_stitch_relative: the stitch is relative to the stitch before it. At position 0 it is
   * relative to 0,0. Appending calls addStitchRelative, updating the position.
   */
  insertStitchRelative(position: number | null, cmd: number, dx = 0, dy = 0): void {
    if (position === null) {
      this.addStitchRelative(cmd, dx, dy);
      return;
    }
    if (position < 0) position += this.stitches.length; // I need positive positions.
    if (position === 0) {
      this.stitches.splice(0, 0, [dx, dy, cmd]); // started (0,0)
    } else if (position === this.stitches.length) {
      this.addStitchRelative(cmd, dx, dy); // This is properly just an add.
    } else if (position > 0 && position < this.stitches.length) {
      const p = this.stitches[position - 1];
      this.stitches.splice(position, 0, [p[0] + dx, p[1] + dy, cmd]);
    }
  }

  /** insert: Python list.insert semantics for the position (negative counts from the end, clamped). */
  insert(position: number, cmd: number, x = 0, y = 0): void {
    this.stitches.splice(position, 0, [x, y, cmd]);
  }

  prependCommand(cmd: number, x = 0, y = 0): void {
    this.stitches.splice(0, 0, [x, y, cmd]);
  }

  /** add_command: a command, without treating parameters as locations that require an update. */
  addCommand(cmd: number, x = 0, y = 0): void {
    this.stitches.push([x, y, cmd]);
  }

  /** add_block (list-of-[x,y,cmd?] form only). */
  addBlock(block: Array<[number, number, number?]> | null, thread: ThreadInput | null = null): void {
    if (thread !== null) this.addThread(thread);
    if (block === null) return;
    if (block.length === 0) return;
    for (const v of block) {
      this.addStitchAbsolute(v[2] === undefined ? STITCH : v[2], v[0], v[1]);
    }
    this.addCommand(COLOR_BREAK);
  }

  /** add_stitchblock */
  addStitchblock(stitchblock: StitchBlock): void {
    const threadlist = this.threads;
    const block = stitchblock[0];
    const thread = stitchblock[1];
    if (threadlist.length === 0 || thread !== threadlist[threadlist.length - 1]) {
      threadlist.push(thread);
      this.addStitchRelative(COLOR_BREAK);
    } else {
      this.addStitchRelative(SEQUENCE_BREAK);
    }
    for (const stitch of block) this.addStitchAbsolute(stitch[2], stitch[0], stitch[1]);
  }

  /**
   * add_pattern: merges the given pattern with the current pattern. If there is an END command on
   * the current pattern, it is removed. If the colour ending the current pattern equals the one
   * starting the next those colour blocks are merged; a prepended thread change is suppressed.
   */
  addPattern(
    pattern: EmbPattern,
    dx: number | null = null,
    dy: number | null = null,
    sx: number | null = null,
    sy: number | null = null,
    rotate: number | null = null,
  ): void {
    // Python's self.stitches[-1] raises IndexError on an empty pattern.
    if (this.stitches.length === 0) throw new RangeError("list index out of range");
    if (this.stitches[this.stitches.length - 1][2] === END) {
      this.stitches = this.stitches.slice(0, -1); // Remove END, if exists
    }
    if (dx !== null || dy !== null) {
      this.addCommand(MATRIX_TRANSLATE, dx ?? 0, dy ?? 0);
    }
    if (sx !== null || sy !== null) {
      const ssx = sx ?? (sy as number);
      const ssy = sy ?? (sx as number);
      this.addCommand(MATRIX_SCALE, ssx, ssy);
    }
    if (rotate !== null) {
      this.addCommand(MATRIX_ROTATE, rotate);
    }
    // Add the new thread only if it's different from the last one
    this.fixColorCount();

    if (pattern.threads.length > 0) {
      if (this.threads.length === 0) throw new RangeError("list index out of range");
      if (pattern.threads[0].equals(this.threads[this.threads.length - 1])) {
        this.threads.push(...pattern.threads.slice(1));
      } else {
        this.threads.push(...pattern.threads);
        this.colorChange();
      }
    }
    const joinPosition = this.stitches.length;
    for (const s of pattern.stitches) this.stitches.push(s);

    for (let i = joinPosition; i < this.stitches.length; i++) {
      const data = this.stitches[i][2] & COMMAND_MASK;
      if (data === STITCH || data === SEW_TO || data === NEEDLE_AT) {
        break;
      } else if (data === COLOR_CHANGE || data === COLOR_BREAK || data === NEEDLE_SET) {
        this.stitches[i][2] = NO_COMMAND;
      }
    }
    Object.assign(this.extras, pattern.extras);
  }

  /** interpolate_duplicate_color_as_stop: replaces duplicate colours in the threadlist with a STOP. */
  interpolateDuplicateColorAsStop(): void {
    let threadIndex = 0;
    let initColor = true;
    let lastChange: number | null = null;
    for (let position = 0; position < this.stitches.length; position++) {
      const data = this.stitches[position][2] & COMMAND_MASK;
      if (data === STITCH || data === SEW_TO || data === NEEDLE_AT) {
        if (initColor) {
          if (lastChange !== null && threadIndex !== 0) {
            // Non-existent threads cannot double (Python IndexError -> return).
            if (threadIndex >= this.threads.length) return;
            if (this.threads[threadIndex - 1].equals(this.threads[threadIndex])) {
              this.threads.splice(threadIndex, 1);
              this.stitches[lastChange][2] = STOP;
            } else {
              threadIndex += 1;
            }
          } else {
            threadIndex += 1;
          }
          initColor = false;
        }
      } else if (data === COLOR_CHANGE || data === COLOR_BREAK || data === NEEDLE_SET) {
        initColor = true;
        lastChange = position;
      }
    }
  }

  /**
   * interpolate_stop_as_duplicate_color: replaces any STOP with a duplicate colour and
   * COLOR_CHANGE (or another specified thread change command).
   */
  interpolateStopAsDuplicateColor(threadChangeCommand: number = COLOR_CHANGE): void {
    let threadIndex = 0;
    for (let position = 0; position < this.stitches.length; position++) {
      const data = this.stitches[position][2] & COMMAND_MASK;
      if (data === STITCH || data === SEW_TO || data === NEEDLE_AT) {
        continue;
      } else if (data === COLOR_CHANGE || data === COLOR_BREAK || data === NEEDLE_SET) {
        threadIndex += 1;
      } else if (data === STOP) {
        if (threadIndex >= this.threads.length) return; // There are no colors to duplicate
        this.threads.splice(threadIndex, 0, this.threads[threadIndex]);
        this.stitches[position][2] = threadChangeCommand;
        threadIndex += 1;
      }
    }
  }

  /** interpolate_frame_eject: replaces jump-stop-jump/jump-stop-end sequences with FRAME_EJECT. */
  interpolateFrameEject(): void {
    let mode = 0;
    let stopX = 0;
    let stopY = 0;
    let sequenceStartPosition: number | null = null;
    let position = 0;
    let ie = this.stitches.length;
    while (position < ie) {
      const stitch = this.stitches[position];
      const data = stitch[2] & COMMAND_MASK;
      if (
        data === STITCH ||
        data === SEW_TO ||
        data === NEEDLE_AT ||
        data === COLOR_CHANGE ||
        data === COLOR_BREAK ||
        data === NEEDLE_SET
      ) {
        if (mode === 3) {
          if (sequenceStartPosition === null) throw new Error("assertion failed");
          this.stitches.splice(sequenceStartPosition, position - sequenceStartPosition);
          position = sequenceStartPosition;
          this.stitches.splice(position, 0, [stopX, stopY, FRAME_EJECT]);
          ie = this.stitches.length;
        }
        mode = 0;
      } else if (data === JUMP) {
        if (mode === 2) mode = 3;
        if (mode === 0) {
          sequenceStartPosition = position;
          mode = 1;
        }
      } else if (data === STOP) {
        if (mode === 1) {
          mode = 2;
          stopX = stitch[0];
          stopY = stitch[1];
        }
      }
      position += 1;
    }
    if (mode >= 2) {
      // Frame_eject at end.
      if (sequenceStartPosition === null) throw new Error("assertion failed");
      this.stitches.splice(sequenceStartPosition, position - sequenceStartPosition);
      position = sequenceStartPosition;
      this.stitches.splice(position, 0, [stopX, stopY, FRAME_EJECT]);
    }
  }

  /** interpolate_trims: adds trims according to the given criteria. */
  interpolateTrims(
    jumpsToRequireTrim: number | null = null,
    distanceToRequireTrim: number | null = null,
    clipping = true,
  ): void {
    let i = -1;
    let ie = this.stitches.length - 1;
    let x = 0;
    let y = 0;
    let jumpCount = 0;
    let jumpStart = 0;
    let jumpDx = 0;
    let jumpDy = 0;
    let jumping = false;
    let trimmed = true;
    while (i < ie) {
      i += 1;
      const stitch = this.stitches[i];
      const dx = stitch[0] - x;
      const dy = stitch[1] - y;
      x = stitch[0];
      y = stitch[1];
      const command = stitch[2] & COMMAND_MASK;
      if (command === STITCH || command === SEQUIN_EJECT) {
        trimmed = false;
        jumping = false;
      } else if (command === COLOR_CHANGE || command === NEEDLE_SET || command === TRIM) {
        trimmed = true;
        jumping = false;
      }
      if (command === JUMP) {
        if (!jumping) {
          jumpDx = 0;
          jumpDy = 0;
          jumpCount = 0;
          jumpStart = i;
          jumping = true;
        }
        jumpCount += 1;
        jumpDx += dx;
        jumpDy += dy;
        if (!trimmed) {
          if (
            jumpCount === jumpsToRequireTrim ||
            (distanceToRequireTrim !== null &&
              (Math.abs(jumpDy) > distanceToRequireTrim || Math.abs(jumpDx) > distanceToRequireTrim))
          ) {
            this.trim(0, 0, jumpStart);
            jumpStart += 1; // We inserted a position, start jump has moved.
            i += 1;
            ie += 1;
            trimmed = true;
          }
        }
        if (clipping && jumpDx === 0 && jumpDy === 0) {
          // jump displacement is 0, clip trim command.
          this.stitches.splice(jumpStart, i + 1 - jumpStart);
          i = jumpStart - 1;
          ie = this.stitches.length - 1;
        }
      }
    }
  }

  /** get_pattern_interpolate_trim */
  getPatternInterpolateTrim(jumpsToRequireTrim: number): EmbPattern {
    const newPattern = new EmbPattern();
    let i = -1;
    const ie = this.stitches.length - 1;
    let count = 0;
    let trimmed = true;
    while (i < ie) {
      i += 1;
      let stitch = this.stitches[i];
      let command = stitch[2] & COMMAND_MASK;
      if (command === STITCH || command === SEQUIN_EJECT) {
        trimmed = false;
      } else if (command === COLOR_CHANGE || command === NEEDLE_SET || command === TRIM) {
        trimmed = true;
      }
      if (trimmed || stitch[2] !== JUMP) {
        newPattern.addStitchAbsolute(stitch[2], stitch[0], stitch[1]);
        continue;
      }
      while (i < ie && command === JUMP) {
        i += 1;
        stitch = this.stitches[i];
        command = stitch[2];
        count += 1;
      }
      if (command !== JUMP) i -= 1;
      stitch = this.stitches[i];
      if (count >= jumpsToRequireTrim) newPattern.trim();
      count = 0;
      newPattern.addStitchAbsolute(stitch[2], stitch[0], stitch[1]);
    }
    newPattern.threads.push(...this.threads);
    Object.assign(newPattern.extras, this.extras);
    return newPattern;
  }

  /** get_pattern_merge_jumps: a pattern with all multiple jumps merged. */
  getPatternMergeJumps(): EmbPattern {
    const newPattern = new EmbPattern();
    let i = -1;
    const ie = this.stitches.length - 1;
    let stitchBreak = false;
    while (i < ie) {
      i += 1;
      const stitch = this.stitches[i];
      const command = stitch[2] & COMMAND_MASK;
      if (command === JUMP) {
        if (stitchBreak) continue;
        newPattern.addCommand(STITCH_BREAK);
        stitchBreak = true;
        continue;
      }
      newPattern.addStitchAbsolute(stitch[2], stitch[0], stitch[1]);
    }
    newPattern.threads.push(...this.threads);
    Object.assign(newPattern.extras, this.extras);
    return newPattern;
  }

  /** get_stable_pattern: a stabilized version of the pattern. */
  getStablePattern(): EmbPattern {
    const stablePattern = new EmbPattern();
    for (const stitchblock of this.getAsStitchblock()) stablePattern.addStitchblock(stitchblock);
    Object.assign(stablePattern.extras, this.extras);
    return stablePattern;
  }

  /** get_normalized_pattern: encodes the pattern, typically for saving. */
  getNormalizedPattern(encodeSettings: EncodeSettings | null = null): EmbPattern {
    const normalPattern = new EmbPattern();
    const transcoder = new Transcoder(encodeSettings);
    transcoder.transcode(this, normalPattern);
    return normalPattern;
  }

  /** append_translation: all later commands are translated by the given amount. */
  appendTranslation(x: number, y: number): void {
    this.addStitchRelative(MATRIX_TRANSLATE, x, y);
  }
}
