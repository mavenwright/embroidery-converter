// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of EmbEncoder.py (the Transcoder that EmbPattern.get_normalized_pattern runs as "Normalizer").
//
// Python numeric semantics reproduced here:
// - Every float expression keeps pystitch's operand order, so the doubles equal Python's floats.
// - round() is banker's rounding (pyRound); round(nan) / round(inf) raise, as in Python.
// - math.ceil(inf) raises OverflowError and x / 0 raises ZeroDivisionError instead of looping or yielding NaN.
// - `%` takes the divisor's sign (pyMod).
// - change_sequence is a dict iterated in insertion order: a Map, never a plain object (integer keys would sort).
// - Negative list indexes count from the end (tie_off reads stitches[position - 1], which is the last stitch at 0).
// - math.sqrt is Math.sqrt (both correctly rounded). math.atan2/cos/sin are Math.atan2/cos/sin: V8 and the C library
//   may differ in the last bit. They only run for tie-on/tie-off anchors farther than max_stitch and for rotation,
//   neither of which the Ink/Stitch export settings use.
import {
  COLOR_BREAK,
  COLOR_CHANGE,
  COMMAND_MASK,
  CONTINGENCY_LONG_STITCH_JUMP_NEEDLE,
  CONTINGENCY_LONG_STITCH_NONE,
  CONTINGENCY_LONG_STITCH_SEW_TO,
  CONTINGENCY_SEQUIN_JUMP,
  CONTINGENCY_SEQUIN_REMOVE,
  CONTINGENCY_SEQUIN_STITCH,
  CONTINGENCY_SEQUIN_UTILIZE,
  CONTINGENCY_TIE_OFF_NONE,
  CONTINGENCY_TIE_OFF_THREE_SMALL,
  CONTINGENCY_TIE_ON_NONE,
  CONTINGENCY_TIE_ON_THREE_SMALL,
  END,
  FAST,
  FLAGS_MASK,
  FRAME_EJECT,
  JUMP,
  MATRIX_RESET,
  MATRIX_ROTATE,
  MATRIX_ROTATE_ORIGIN,
  MATRIX_SCALE,
  MATRIX_SCALE_ORIGIN,
  MATRIX_TRANSLATE,
  NEEDLE_AT,
  NEEDLE_SET,
  NO_COMMAND,
  OPTION_EXPLICIT_TRIM,
  OPTION_IMPLICIT_TRIM,
  OPTION_MAX_JUMP_LENGTH,
  OPTION_MAX_STITCH_LENGTH,
  SEQUENCE_BREAK,
  SEQUIN_EJECT,
  SEQUIN_MODE,
  SET_CHANGE_SEQUENCE,
  SEW_TO,
  SLOW,
  STITCH,
  STITCH_BREAK,
  STOP,
  TIE_OFF,
  TIE_ON,
  TRIM,
} from "./constants";
import { decodeEmbroideryCommand, encodeThreadChange } from "./functions";
import { EmbMatrix } from "./matrix";
import type { EmbPattern, Stitch } from "./pattern";
import { pyTruthy, settingsGet, type WriterSettings } from "./settings";
import { pyRound, type EmbThread } from "./thread";

/** A change_sequence entry: [command, thread index, needle, thread]. */
type ChangeEntry = [command: number | null, thread: number | null, needle: number | null, threadObject: EmbThread | null];

/** Python's round() on a number: banker's rounding, and the errors round() raises for nan and inf. */
function pyRoundStrict(v: number): number {
  if (Number.isNaN(v)) throw new RangeError("ValueError: cannot convert float NaN to integer");
  if (!Number.isFinite(v)) throw new RangeError("OverflowError: cannot convert float infinity to integer");
  return pyRound(v);
}

/** math.ceil: raises for inf and nan where JS would return them. */
function pyCeil(v: number): number {
  if (Number.isNaN(v)) throw new RangeError("ValueError: cannot convert float NaN to integer");
  if (!Number.isFinite(v)) throw new RangeError("OverflowError: cannot convert float infinity to integer");
  return Math.ceil(v);
}

/** Python's a % b: the result takes the divisor's sign; modulo by zero raises. */
export function pyMod(a: number, b: number): number {
  if (b === 0) throw new RangeError("ZeroDivisionError: integer modulo by zero");
  let r = a % b;
  if (r !== 0 && r < 0 !== b < 0) r += b;
  return r;
}

/** Python's a / b: division by zero raises. */
function pyDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("ZeroDivisionError: float division by zero");
  return a / b;
}

/** list[index] with Python's negative indexes; undefined where Python raises IndexError. */
function pyIndex<T>(list: readonly T[], index: number): T | undefined {
  if (index < 0) index += list.length;
  if (index < 0 || index >= list.length) return undefined;
  return list[index];
}

export class Transcoder {
  maxStitch: number;
  maxJump: number;
  fullJump: boolean | null;
  round: boolean | null;
  needleCount: number;
  threadChangeCommand: number;
  sequinContingency: number;
  writesSpeeds: boolean | null;
  explicitTrim: boolean | null;
  tieOnContingency: number | boolean;
  tieOffContingency: number | boolean;
  longStitchContingency: number;
  matrix: EmbMatrix;
  sourcePattern: EmbPattern | null = null;
  destinationPattern: EmbPattern | null = null;
  position = 0;
  orderIndex = -1;
  changeSequence: Map<number, ChangeEntry> = new Map();
  stitch: Stitch | null = null;
  stateTrimmed = true;
  stateSequinMode = false;
  stateJumping = false;
  needleX = 0;
  needleY = 0;
  highFlags = 0;

  constructor(settings?: WriterSettings | null) {
    if (settings == null) settings = {};
    this.maxStitch = settingsGet(settings, "max_stitch", Infinity) as number;
    this.maxJump = settingsGet(settings, "max_jump", Infinity) as number;
    this.fullJump = settingsGet(settings, "full_jump", false);
    this.round = settingsGet(settings, "round", false);
    this.needleCount = settingsGet(settings, "needle_count", 5) as number;
    this.threadChangeCommand = settingsGet(settings, "thread_change_command", COLOR_CHANGE) as number;
    if (this.needleCount <= 1 && this.threadChangeCommand === NEEDLE_SET) {
      this.threadChangeCommand = STOP;
    }
    const stripSequins = settingsGet(settings, "strip_sequins", true);
    // deprecated, use sequin_contingency.
    if (pyTruthy(stripSequins)) {
      this.sequinContingency = CONTINGENCY_SEQUIN_JUMP;
    } else {
      this.sequinContingency = CONTINGENCY_SEQUIN_UTILIZE;
    }
    this.sequinContingency = settingsGet(settings, "sequin_contingency", this.sequinContingency) as number;

    this.writesSpeeds = settingsGet(settings, "writes_speeds", true);
    this.explicitTrim = settingsGet(settings, "explicit_trim", false);

    this.tieOnContingency = settingsGet(settings, "tie_on", CONTINGENCY_TIE_ON_NONE) as number | boolean;
    if (this.tieOnContingency === true) this.tieOnContingency = CONTINGENCY_TIE_ON_THREE_SMALL;
    if (this.tieOnContingency === false) this.tieOnContingency = CONTINGENCY_TIE_ON_NONE;

    this.tieOffContingency = settingsGet(settings, "tie_off", CONTINGENCY_TIE_OFF_NONE) as number | boolean;
    if (this.tieOffContingency === true) this.tieOffContingency = CONTINGENCY_TIE_OFF_THREE_SMALL;
    if (this.tieOffContingency === false) this.tieOffContingency = CONTINGENCY_TIE_OFF_NONE;

    this.longStitchContingency = settingsGet(
      settings,
      "long_stitch_contingency",
      CONTINGENCY_LONG_STITCH_JUMP_NEEDLE,
    ) as number;

    this.matrix = new EmbMatrix();
    const translate = settingsGet(settings, "translate", null);
    if (translate !== null) {
      if (Array.isArray(translate)) {
        // A sequence shorter than 2 raises IndexError, then has no .x/.y: ignored.
        if (translate.length >= 2) this.matrix.postTranslate(translate[0], translate[1]);
      } else {
        throw new TypeError("translate must be a sequence [x, y]");
      }
    }
    const scale = settingsGet(settings, "scale", null);
    if (scale !== null) {
      if (Array.isArray(scale) && scale.length >= 2) {
        this.matrix.postScale(scale[0], scale[1]);
      } else if (typeof scale === "number") {
        this.matrix.postScale(scale, scale);
      } else {
        throw new TypeError("scale must be a number or a sequence [sx, sy]");
      }
    }
    const rotate = settingsGet(settings, "rotate", null);
    if (rotate !== null) this.matrix.postRotate(rotate);
  }

  private get source(): EmbPattern {
    return this.sourcePattern as EmbPattern;
  }

  private get destination(): EmbPattern {
    return this.destinationPattern as EmbPattern;
  }

  transcode(sourcePattern: EmbPattern, destinationPattern: EmbPattern): EmbPattern {
    if (sourcePattern === destinationPattern) {
      // both objects are same. Source is copy, destination is cleared.
      sourcePattern = destinationPattern.copy();
      destinationPattern.clear();
    }
    this.sourcePattern = sourcePattern;
    this.destinationPattern = destinationPattern;
    this.transcodeMetadata();
    this.transcodeMain();
    return destinationPattern;
  }

  /** Transcodes metadata, (just moves) */
  transcodeMetadata(): void {
    Object.assign(this.destination.extras, this.source.extras);
  }

  /**
   * Generates the sequence change events with their relevant indexes. If there is a sewing event prior to the
   * thread sequence event, the first event is indexed as 1. If the first event is a discrete event, occurring before
   * the sewing starts it's indexed as zero.
   */
  *getAsThreadChangeSequenceEvents(): Generator<
    [flags: number, thread: number | null, needle: number | null, order: number | null, currentIndex: number | null]
  > {
    const source = this.source.stitches;
    let currentIndex = 0;
    for (const stitch of source) {
      const [flags, thread, needle, order] = decodeEmbroideryCommand(stitch[2]);
      if (currentIndex === 0) {
        if (flags === STITCH || flags === SEW_TO || flags === NEEDLE_AT || flags === SEQUIN_EJECT) {
          currentIndex = 1;
        }
      }
      if (flags === SET_CHANGE_SEQUENCE) {
        yield [flags, thread, needle, order, null];
      } else if (flags === NEEDLE_SET || flags === COLOR_CHANGE || flags === COLOR_BREAK) {
        yield [flags, thread, needle, order, currentIndex];
        currentIndex += 1;
      }
    }
  }

  /** Builds a change sequence to plan out all the color changes for the file. */
  buildThreadChangeSequence(): Map<number, ChangeEntry> {
    const changeSequence = new Map<number, ChangeEntry>();
    let lookaheadIndex = 0;
    changeSequence.set(0, [null, null, null, null]);
    const lookup = (key: number): ChangeEntry => {
      let current = changeSequence.get(key);
      if (current === undefined) {
        current = [null, null, null, null];
        changeSequence.set(key, current);
      }
      return current;
    };
    for (const [flags, thread, needle, order, currentIndex] of this.getAsThreadChangeSequenceEvents()) {
      let current: ChangeEntry;
      if (flags === SET_CHANGE_SEQUENCE) {
        if (order === null) {
          current = lookup(lookaheadIndex);
          lookaheadIndex += 1;
        } else {
          current = lookup(order);
        }
      } else {
        const index = currentIndex as number;
        current = lookup(index);
        if (index >= lookaheadIndex) lookaheadIndex = index + 1;
      }
      if (flags === COLOR_CHANGE || flags === NEEDLE_SET) current[0] = flags;
      if (thread !== null) {
        current[1] = thread;
        current[3] = this.source.getThreadOrFiller(thread);
      }
      if (needle !== null) current[2] = needle;
    }
    // TODO: account for contingency where threadset repeats threads without explicit values set within the commands.

    const needleLimit = this.needleCount;
    let threadIndex = 0;
    let needleIndex = 1;
    for (const s of changeSequence.values()) {
      if (s[0] === null) s[0] = this.threadChangeCommand;
      if (s[1] === null) {
        s[1] = threadIndex;
        threadIndex += 1;
      }
      if (s[2] === null) {
        s[2] = needleIndex;
        if (s[2] > needleLimit) {
          s[2] = pyMod(s[2] - 1, needleLimit);
          s[2] += 1;
        }
        needleIndex += 1;
      }
      if (s[3] === null) s[3] = this.source.getThreadOrFiller(s[1]);
    }
    return changeSequence;
  }

  /**
   * Transcodes stitches. Converts middle-level commands and potentially incompatible commands into a format friendly
   * low level commands.
   */
  transcodeMain(): void {
    const source = this.source.stitches;
    this.stateTrimmed = true;
    this.needleX = 0;
    this.needleY = 0;
    this.position = 0;
    this.orderIndex = -1;
    this.changeSequence = this.buildThreadChangeSequence();
    if (this.threadChangeCommand === NEEDLE_SET) {
      this.destination.threads.push(...this.source.threads);
    }

    let flags = NO_COMMAND;
    // for self.position, self.stitch in enumerate(source): position stays on the last stitch after the loop.
    for (let position = 0; position < source.length; position++) {
      this.position = position;
      const stitch = source[position];
      this.stitch = stitch;
      const p = this.matrix.pointInMatrixSpace(stitch);
      let x = p[0];
      let y = p[1];
      if (pyTruthy(this.round)) {
        x = pyRoundStrict(x);
        y = pyRoundStrict(y);
      }
      flags = stitch[2] & COMMAND_MASK;
      this.highFlags = stitch[2] & FLAGS_MASK;

      if (flags === NO_COMMAND) {
        continue; // Never true: NO_COMMAND & COMMAND_MASK is 255, as in pystitch.
      } else if (flags === STITCH) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.stitchWithContingency(x, y);
        }
      } else if (flags === NEEDLE_AT) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.needleTo(x, y);
        }
      } else if (flags === SEW_TO) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.sewTo(x, y);
        }
      }
      // Middle Level Commands.
      else if (flags === STITCH_BREAK) {
        this.stateJumping = true;
      } else if (flags === FRAME_EJECT) {
        this.tieOffAndTrimIfNeeded();
        this.jumpTo(x, y);
        this.stopHere();
      } else if (flags === SEQUENCE_BREAK) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === COLOR_BREAK) {
        this.colorBreak();
      } else if (flags === TIE_OFF) {
        this.tieOff();
      } else if (flags === TIE_ON) {
        this.tieOn();
      }
      // Core Commands.
      else if (flags === TRIM) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === JUMP) {
        if (!this.stateJumping) this.jumpTo(x, y);
      } else if (flags === SEQUIN_MODE) {
        this.toggleSequins();
      } else if (flags === SEQUIN_EJECT) {
        if (this.stateTrimmed) {
          this.declareNotTrimmed();
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          this.tieOn();
        }
        if (!this.stateSequinMode) this.toggleSequins();
        this.sequinAt(x, y);
      } else if (flags === COLOR_CHANGE) {
        this.tieOffTrimColorChange();
      } else if (flags === NEEDLE_SET) {
        this.tieOffTrimColorChange();
      } else if (flags === STOP) {
        this.stopHere();
      } else if (flags === SLOW) {
        this.slowCommandHere();
      } else if (flags === FAST) {
        this.fastCommandHere();
      } else if (flags === END) {
        this.endHere();
        break;
      }
      // On-the-fly Settings Commands.
      else if (flags === CONTINGENCY_TIE_ON_THREE_SMALL) {
        this.tieOnContingency = CONTINGENCY_TIE_ON_THREE_SMALL;
      } else if (flags === CONTINGENCY_TIE_OFF_THREE_SMALL) {
        this.tieOffContingency = CONTINGENCY_TIE_OFF_THREE_SMALL;
      } else if (flags === CONTINGENCY_TIE_ON_NONE) {
        this.tieOnContingency = CONTINGENCY_TIE_ON_NONE;
      } else if (flags === CONTINGENCY_TIE_OFF_NONE) {
        this.tieOffContingency = CONTINGENCY_TIE_OFF_NONE;
      } else if (flags === OPTION_MAX_JUMP_LENGTH) {
        x = stitch[0];
        this.maxJump = x;
      } else if (flags === OPTION_MAX_STITCH_LENGTH) {
        x = stitch[0];
        this.maxStitch = x;
      } else if (flags === OPTION_EXPLICIT_TRIM) {
        this.explicitTrim = true;
      } else if (flags === OPTION_IMPLICIT_TRIM) {
        this.explicitTrim = false;
      } else if (flags === CONTINGENCY_LONG_STITCH_NONE) {
        this.longStitchContingency = CONTINGENCY_LONG_STITCH_NONE;
      } else if (flags === CONTINGENCY_LONG_STITCH_JUMP_NEEDLE) {
        this.longStitchContingency = CONTINGENCY_LONG_STITCH_JUMP_NEEDLE;
      } else if (flags === CONTINGENCY_LONG_STITCH_SEW_TO) {
        this.longStitchContingency = CONTINGENCY_LONG_STITCH_SEW_TO;
      } else if (flags === CONTINGENCY_SEQUIN_REMOVE) {
        if (this.stateSequinMode) this.toggleSequins(); // if sequin_mode, turn it off.
        this.sequinContingency = CONTINGENCY_SEQUIN_REMOVE;
      } else if (flags === CONTINGENCY_SEQUIN_STITCH) {
        if (this.stateSequinMode) this.toggleSequins(); // if sequin_mode, turn it off.
        this.sequinContingency = CONTINGENCY_SEQUIN_STITCH;
      } else if (flags === CONTINGENCY_SEQUIN_JUMP) {
        if (this.stateSequinMode) this.toggleSequins(); // if sequin_mode, turn it off.
        this.sequinContingency = CONTINGENCY_SEQUIN_JUMP;
      } else if (flags === CONTINGENCY_SEQUIN_UTILIZE) {
        this.sequinContingency = CONTINGENCY_SEQUIN_UTILIZE;
      } else if (flags === MATRIX_TRANSLATE) {
        this.matrix.postTranslate(stitch[0], stitch[1]);
      } else if (flags === MATRIX_SCALE_ORIGIN) {
        this.matrix.postScale(stitch[0], stitch[1]);
      } else if (flags === MATRIX_ROTATE_ORIGIN) {
        this.matrix.postRotate(stitch[0]);
      } else if (flags === MATRIX_SCALE) {
        this.matrix.inverse();
        const q = this.matrix.pointInMatrixSpace(this.needleX, this.needleY);
        this.matrix.inverse();
        this.matrix.postScale(stitch[0], stitch[1], q[0], q[1]);
      } else if (flags === MATRIX_ROTATE) {
        this.matrix.inverse();
        const q = this.matrix.pointInMatrixSpace(this.needleX, this.needleY);
        this.matrix.inverse();
        this.matrix.postRotate(stitch[0], q[0], q[1]);
      } else if (flags === MATRIX_RESET) {
        this.matrix.reset();
      }
    }
    if (flags !== END) this.endHere();
  }

  updateNeedlePosition(x: number, y: number): void {
    this.needleX = x;
    this.needleY = y;
  }

  declareNotTrimmed(): void {
    if (this.orderIndex === -1) this.nextChangeSequence();
    this.stateTrimmed = false;
  }

  addThreadChange(command: number, thread: number | null = null, needle: number | null = null, order: number | null = null): void {
    const x = this.needleX;
    const y = this.needleY;
    const cmd = encodeThreadChange(command, thread, needle, order);
    this.destination.stitches.push([x, y, cmd]);
  }

  add(flags: number, x: number | null = null, y: number | null = null): void {
    if (x === null) x = this.needleX;
    if (y === null) y = this.needleY;
    flags |= this.highFlags;
    this.destination.stitches.push([x, y, flags]);
  }

  /** Looks forward from current position and determines if anymore stitching will occur. */
  lookaheadStitch(): boolean {
    const source = this.source.stitches;
    for (let pos = this.position; pos < source.length; pos++) {
      const flags = source[pos][2]; // Not masked, as in pystitch.
      if (flags === STITCH) return true;
      else if (flags === NEEDLE_AT) return true;
      else if (flags === SEW_TO) return true;
      else if (flags === TIE_ON) return true;
      else if (flags === SEQUIN_EJECT) return true;
      else if (flags === END) return false;
    }
    return false;
  }

  /** Implements color break. Should add color changes add needed only. */
  colorBreak(): void {
    if (this.orderIndex < 0) return; // We haven't stitched anything, colorbreak happens, before start. Ignore.
    if (!this.stateTrimmed) {
      this.tieOff();
      if (pyTruthy(this.explicitTrim)) this.trimHere();
    }
    if (!this.lookaheadStitch()) return; // No more stitching will happen, colorchange unneeded.
    this.nextChangeSequence();
    this.stateTrimmed = true;
  }

  tieOffTrimColorChange(): void {
    if (!this.stateTrimmed) {
      this.tieOff();
      if (pyTruthy(this.explicitTrim)) this.trimHere();
    }
    this.nextChangeSequence();
    this.stateTrimmed = true;
  }

  tieOffAndTrimIfNeeded(): void {
    if (!this.stateTrimmed) this.tieOffAndTrim();
  }

  tieOffAndTrim(): void {
    this.tieOff();
    this.trimHere();
  }

  tieOff(): void {
    if (this.tieOffContingency === CONTINGENCY_TIE_OFF_THREE_SMALL) {
      const previous = pyIndex(this.source.stitches, this.position - 1);
      if (previous === undefined) return; // must be an island stitch. jump-stitch-jump
      const b = this.matrix.pointInMatrixSpace(previous);
      const flags = b[2];
      if (flags === STITCH || flags === NEEDLE_AT || flags === SEW_TO || flags === SEQUIN_EJECT) {
        this.lockStitch(this.needleX, this.needleY, b[0], b[1], this.maxStitch);
      }
    }
  }

  tieOn(): void {
    if (this.tieOnContingency === CONTINGENCY_TIE_ON_THREE_SMALL) {
      const next = pyIndex(this.source.stitches, this.position + 1);
      if (next === undefined) return; // must be an island stitch. jump-stitch-jump
      const b = this.matrix.pointInMatrixSpace(next);
      const flags = b[2];
      if (flags === STITCH || flags === NEEDLE_AT || flags === SEW_TO || flags === SEQUIN_EJECT) {
        this.lockStitch(this.needleX, this.needleY, b[0], b[1], this.maxStitch);
      }
    }
  }

  trimHere(): void {
    if (this.stateSequinMode) {
      // Can't trim in sequin mode. DST uses jumps to trigger sequin eject and to trim.
      this.toggleSequins();
    }
    this.add(TRIM);
    this.stateTrimmed = true;
  }

  /**
   * Sequin mode toggle can be called whenever but will only actually turn on if set to utilize mode for the sequin
   * contingency.
   */
  toggleSequins(): void {
    const contingency = this.sequinContingency;
    if (contingency === CONTINGENCY_SEQUIN_UTILIZE) {
      this.add(SEQUIN_MODE);
      this.stateSequinMode = !this.stateSequinMode;
    }
  }

  /** Jumps close enough to stitch a position in x,y without violating the length constraints. */
  jumpToWithinStitchrange(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxJump;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    if (pyTruthy(this.fullJump)) {
      if (this.needleX !== newX || this.needleY !== newY) this.jumpAt(newX, newY);
    }
    // We are currently assuming that max_jump is also max_stitch.
    // Properly it might be the case that some format could require
    // a split constraint here where we would need to jump further
    // so that we could then stitch closer.
  }

  jumpTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxJump;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    this.jumpAt(newX, newY);
  }

  jumpAt(newX: number, newY: number): void {
    if (this.stateSequinMode) this.toggleSequins(); // can't jump with sequin mode on.
    this.add(JUMP, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  stitchWithContingency(newX: number, newY: number): void {
    if (this.longStitchContingency === CONTINGENCY_LONG_STITCH_SEW_TO) {
      this.sewTo(newX, newY);
    } else if (this.longStitchContingency === CONTINGENCY_LONG_STITCH_JUMP_NEEDLE) {
      this.needleTo(newX, newY);
    } else {
      this.stitchAt(newX, newY);
    }
  }

  /** Stitches to a specific location, with the emphasis on sewing. Subdivides long stitches into additional stitches. */
  sewTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxStitch;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, STITCH);
    this.stitchAt(newX, newY);
  }

  /**
   * Insert needle at specific location, emphasis on the needle. Uses jumps to avoid needle penetrations where
   * possible. The limit here is the max stitch limit or jump threshold. If jump threshold is set low, it will insert
   * jumps even between stitches it could have technically encoded values for. Stitches to the new location, adding
   * jumps if needed.
   */
  needleTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxStitch;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    this.stitchAt(newX, newY);
  }

  /** Inserts a stitch at the specific location. Should have already been checked for constraints. */
  stitchAt(newX: number, newY: number): void {
    this.add(STITCH, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  /**
   * Sequin Ejects at position with the proper Sequin Contingency. If long stitch contingency is required and since
   * JUMP is often sequin eject, the contingency for long stitch is always sew to.
   */
  sequinAt(newX: number, newY: number): void {
    const contingency = this.sequinContingency;
    if (contingency === CONTINGENCY_SEQUIN_REMOVE) {
      // Do not update the needle position or declare untrimmed.
      return;
    }
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxStitch;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, STITCH);
    if (contingency === CONTINGENCY_SEQUIN_UTILIZE) {
      this.add(SEQUIN_EJECT, newX, newY);
    } else if (contingency === CONTINGENCY_SEQUIN_JUMP) {
      this.add(JUMP, newX, newY);
    } else if (contingency === CONTINGENCY_SEQUIN_STITCH) {
      this.add(STITCH, newX, newY);
    }
    this.updateNeedlePosition(newX, newY);
  }

  slowCommandHere(): void {
    if (pyTruthy(this.writesSpeeds)) this.add(SLOW);
  }

  fastCommandHere(): void {
    if (pyTruthy(this.writesSpeeds)) this.add(FAST);
  }

  stopHere(): void {
    this.add(STOP);
    this.stateTrimmed = true;
  }

  endHere(): void {
    this.add(END);
    this.stateTrimmed = true;
  }

  nextChangeSequence(): void {
    this.orderIndex += 1;
    const change = this.changeSequence.get(this.orderIndex);
    if (change === undefined) throw new RangeError(`KeyError: ${this.orderIndex}`);
    const threadlist = this.destination.threads;
    if (this.threadChangeCommand === COLOR_CHANGE) {
      threadlist.push(change[3] as EmbThread);
      if (this.orderIndex !== 0) this.addThreadChange(COLOR_CHANGE, change[1], change[2]);
    } else if (this.threadChangeCommand === NEEDLE_SET) {
      // We do not append the thread, we already have all threads
      this.addThreadChange(NEEDLE_SET, change[1], change[2]);
    } else if (this.threadChangeCommand === STOP) {
      threadlist.push(change[3] as EmbThread);
      this.addThreadChange(STOP, change[1], change[2]);
    }
    this.stateTrimmed = true;
  }

  /** Check if the stitch is too long before trying to deal with it. */
  positionWillExceedConstraint(length: number | null = null, newX: number | null = null, newY: number | null = null): boolean {
    if (length === null) length = this.maxStitch;
    if (newX === null || newY === null) {
      const stitch = this.stitch as Stitch;
      const p = this.matrix.pointInMatrixSpace(stitch[0], stitch[1]);
      newX = p[0];
      newY = p[1];
    }
    const distanceX = newX - this.needleX;
    const distanceY = newY - this.needleY;
    return Math.abs(distanceX) > length || Math.abs(distanceY) > length;
  }

  /**
   * Command sequence line to x, y, respecting length as maximum. This does not arrive_at, it steps to within striking
   * distance. The next step can arrive at (x, y) without violating constraint. If these are already in range, this
   * command will do nothing.
   */
  interpolateGapStitches(x0: number, y0: number, x1: number, y1: number, maxLength: number, data: number): void {
    const transcode = this.destination.stitches;
    const distanceX = x1 - x0;
    const distanceY = y1 - y0;
    if (Math.abs(distanceX) > maxLength || Math.abs(distanceY) > maxLength) {
      if (data === JUMP && this.stateSequinMode) this.toggleSequins(); // can't jump with sequin mode on.

      // python 2,3 patch of division that could be integer.
      const stepsX = pyCeil(Math.abs(pyDiv(distanceX, maxLength * 1.0)));
      const stepsY = pyCeil(Math.abs(pyDiv(distanceY, maxLength * 1.0)));
      let steps: number;
      if (stepsX > stepsY) steps = stepsX;
      else steps = stepsY;
      const stepSizeX = pyDiv(distanceX, steps);
      const stepSizeY = pyDiv(distanceY, steps);
      let qx = x0;
      let qy = y0;
      for (let q = 1; q < steps; q++) {
        // we need the gap stitches only, not start or end stitch.
        qx += stepSizeX;
        qy += stepSizeY;
        const stitch: Stitch = [qx, qy, data | this.highFlags];
        transcode.push(stitch);
        this.updateNeedlePosition(stitch[0], stitch[1]);
      }
    }
  }

  /**
   * Tie-on, Tie-off. Lock stitch from current location towards anchor location. Ends again at lock location. May not
   * exceed max_length in the process.
   */
  lockStitch(x: number, y: number, anchorX: number, anchorY: number, maxLength: number | null = null): void {
    if (maxLength === null) maxLength = this.maxStitch;
    const transcode = this.destination.stitches;
    const length = distance(x, y, anchorX, anchorY);
    if (length > maxLength) {
      const p = oriented(x, y, anchorX, anchorY, maxLength);
      anchorX = p[0];
      anchorY = p[1];
    }
    for (const amount of [0.33, 0.66, 0.33, 0]) {
      transcode.push([towards(x, anchorX, amount), towards(y, anchorY, amount), STITCH]);
    }
  }
}

/** squared of distance between x0,y0 and x1,y1 */
export function distanceSquared(x0: number, y0: number, x1: number, y1: number): number {
  let dx = x1 - x0;
  let dy = y1 - y0;
  dx *= dx;
  dy *= dy;
  return dx + dy;
}

/** distance between x0,y0 and x1,y1 */
export function distance(x0: number, y0: number, x1: number, y1: number): number {
  return Math.sqrt(distanceSquared(x0, y0, x1, y1));
}

/** amount between [0,1] -> [a,b] */
export function towards(a: number, b: number, amount: number): number {
  return amount * (b - a) + a;
}

/** Angle in radians between x0,y0 and x1,y1 */
export function angleRadians(x0: number, y0: number, x1: number, y1: number): number {
  return Math.atan2(y1 - y0, x1 - x0);
}

/** from x0,y0 in the direction of x1,y1 in the distance of r */
export function oriented(x0: number, y0: number, x1: number, y1: number, r: number): [number, number] {
  const radians = angleRadians(x0, y0, x1, y1);
  return [x0 + r * Math.cos(radians), y0 + r * Math.sin(radians)];
}

/**
 * EmbPattern.get_normalized_pattern: the pattern encoded for a writer whose limits `settings` describes (usually
 * `effectiveSettings(format, userSettings)`). The source pattern is not modified.
 */
export function normalize(pattern: EmbPattern, settings: WriterSettings): EmbPattern {
  return pattern.getNormalizedPattern(settings);
}
