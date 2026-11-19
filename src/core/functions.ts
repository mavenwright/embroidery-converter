// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of the command encode/decode helpers from EmbFunctions.py.
import { COMMAND_MASK, NEEDLE_MASK, ORDER_MASK, THREAD_MASK } from "./constants";

/** encode_thread_change. Result is an unsigned 32-bit value, as in Python. */
export function encodeThreadChange(
  command: number,
  thread: number | null = null,
  needle: number | null = null,
  order: number | null = null,
): number {
  let t = 0;
  if (thread !== null) t = (thread & 0xff) + 1;
  let n = 0;
  if (needle !== null) n = (needle & 0xff) + 1;
  let o = 0;
  if (order !== null) o = (order & 0xff) + 1;
  command &= COMMAND_MASK;
  return (command | (o << 24) | (n << 16) | (t << 8)) >>> 0;
}

/** decode_embroidery_command: [flag, thread, needle, order], absent values are null. */
export function decodeEmbroideryCommand(
  command: number,
): [flag: number, thread: number | null, needle: number | null, order: number | null] {
  const flag = command & COMMAND_MASK;
  const thread = ((command & THREAD_MASK) >>> 8) - 1;
  const needle = ((command & NEEDLE_MASK) >>> 16) - 1;
  const order = ((command & ORDER_MASK) >>> 24) - 1;
  return [flag, thread === -1 ? null : thread, needle === -1 ? null : needle, order === -1 ? null : order];
}
