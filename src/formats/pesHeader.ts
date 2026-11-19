// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of the header half of PesReader.py (pystitch 1.0.1): the per-version PES headers between the PEC offset and
// the PEC block (metadata from version 4, thread tables from version 5). readPes (./pes) reads the rest.
//
// pystitch -> TS: the version if/elif chain of read -> readPesHeader; read_pes_string -> readPesString;
// read_pes_metadata -> readPesMetadata; read_pes_thread -> readPesThread; read_pes_header_version_N ->
// readPesHeaderVersionN (1, 4, 5, 6, 7, 8, 9, 10). The thread-table tail the version 5 to 10 functions share is
// readPesThreadTable.
import { EmbPattern } from "../core/pattern";
import { EmbThread } from "../core/thread";
import { ByteReader } from "../io/reader";

/** The PES metadata strings, in file order (read_pes_metadata and write_pes_header_v6). */
export const METADATA_KEYS = ["name", "category", "author", "keywords", "comments"] as const;

/**
 * The version branch of PesReader.read: sets the "version" metadata and reads that version's header (metadata,
 * thread table) into `out` and `threadlist`. An unrecognised signature reads nothing, as in pystitch.
 */
export function readPesHeader(pesString: string | null, f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  // Ignoring several known PES versions, just abort and read PEC block
  // All versions allow, abort and read PEC block.
  // Metadata started appearing in V4
  // Threads appeared in V5.
  // We quickly abort if there are any complex items in the header.
  if (pesString === "#PES0100") {
    out.metadata("version", 10);
    readPesHeaderVersion10(f, out, threadlist);
  } else if (pesString === "#PES0090") {
    out.metadata("version", 9);
    readPesHeaderVersion9(f, out, threadlist);
  } else if (pesString === "#PES0080") {
    out.metadata("version", 8);
    readPesHeaderVersion8(f, out, threadlist);
  } else if (pesString === "#PES0070") {
    out.metadata("version", 7);
    readPesHeaderVersion7(f, out, threadlist);
  } else if (pesString === "#PES0060") {
    out.metadata("version", 6);
    readPesHeaderVersion6(f, out, threadlist);
  } else if (pesString === "#PES0050") {
    out.metadata("version", 5);
    readPesHeaderVersion5(f, out, threadlist);
  } else if (pesString === "#PES0055") {
    out.metadata("version", 5.5);
    readPesHeaderVersion5(f, out, threadlist);
  } else if (pesString === "#PES0056") {
    out.metadata("version", 5.6);
    readPesHeaderVersion5(f, out, threadlist);
  } else if (pesString === "#PES0040") {
    out.metadata("version", 4);
    readPesHeaderVersion4(f, out);
  } else if (pesString === "#PES0030") {
    out.metadata("version", 3);
  } else if (pesString === "#PES0022") {
    out.metadata("version", 2.2);
  } else if (pesString === "#PES0020") {
    out.metadata("version", 2);
  } else if (pesString === "#PES0001") {
    out.metadata("version", 1);
    readPesHeaderVersion1(f, out);
  } else {
    // Header is unrecognised.
  }
}

/** read_pes_string: a length byte, then that many UTF-8 bytes (null for 0 or undecodable bytes). */
export function readPesString(f: ByteReader): string | null {
  const length = f.uint8();
  if (length === 0) return null;
  // At the end, read_int_8 gives None and read_string_8(f, None) reads the (empty) rest: "".
  return f.string(length === null ? -1 : length);
}

function readStringMetadata(f: ByteReader, out: EmbPattern, key: string): void {
  const v = readPesString(f);
  if (v !== null && v.length > 0) out.metadata(key, v);
}

function readPesMetadata(f: ByteReader, out: EmbPattern): void {
  for (const key of METADATA_KEYS) readStringMetadata(f, out, key);
}

function readPesThread(f: ByteReader, threadlist: EmbThread[]): void {
  const thread = new EmbThread();
  thread.catalogNumber = readPesString(f);
  const rgb = f.int24be();
  if (rgb === null) throw new Error("Can't read this PES file: truncated thread table."); // 0xFF000000 | None
  thread.color = 0xff000000 + rgb; // 0xFF000000 | rgb, a positive int as in Python
  f.seek(5, 1);
  thread.description = readPesString(f);
  thread.brand = readPesString(f);
  thread.chart = readPesString(f);
  threadlist.push(thread);
}

/** The thread table that ends the version 5 to 10 headers (skipped when complex items are present). */
function readPesThreadTable(f: ByteReader, threadlist: EmbThread[]): void {
  const countProgrammableFills = f.int16le();
  if (countProgrammableFills !== 0) return;
  const countMotifs = f.int16le();
  if (countMotifs !== 0) return;
  const countFeatherPatterns = f.int16le();
  if (countFeatherPatterns !== 0) return;
  const countThreads = f.int16le();
  if (countThreads === null) throw new Error("Can't read this PES file: truncated thread table."); // range(None)
  for (let i = 0; i < countThreads; i++) readPesThread(f, threadlist);
}

function readPesHeaderVersion1(_f: ByteReader, _out: EmbPattern): void {
  // Nothing I care about.
}

function readPesHeaderVersion4(f: ByteReader, out: EmbPattern): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
}

function readPesHeaderVersion5(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(24, 1); // this is 36 in version 6 and 24 in version 5
  readStringMetadata(f, out, "image");
  f.seek(24, 1);
  readPesThreadTable(f, threadlist);
}

function readPesHeaderVersion6(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(36, 1); // this is 36 in version 6 and 24 in version 5
  readStringMetadata(f, out, "image_file");
  f.seek(24, 1);
  readPesThreadTable(f, threadlist);
}

function readPesHeaderVersion7(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(36, 1);
  readStringMetadata(f, out, "image_file");
  f.seek(24, 1);
  readPesThreadTable(f, threadlist);
}

function readPesHeaderVersion8(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(38, 1);
  readStringMetadata(f, out, "image_file");
  f.seek(26, 1);
  readPesThreadTable(f, threadlist);
}

function readPesHeaderVersion9(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(14, 1);
  readStringMetadata(f, out, "hoop_name");
  f.seek(30, 1); // this is 36 in version 6 and 24 in version 5
  readStringMetadata(f, out, "image_file");
  f.seek(34, 1);
  readPesThreadTable(f, threadlist);
}

function readPesHeaderVersion10(f: ByteReader, out: EmbPattern, threadlist: EmbThread[]): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(14, 1);
  readStringMetadata(f, out, "hoop_name");
  f.seek(38, 1);
  readStringMetadata(f, out, "image_file");
  f.seek(34, 1);
  readPesThreadTable(f, threadlist);
}
