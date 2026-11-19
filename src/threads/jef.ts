// Ported from pystitch (https://github.com/inkstitch/pystitch), MIT License, Copyright (c) 2018 pyembroidery/pystitch contributors.
// Port of EmbThreadJef.py (pystitch 1.0.1): Janome's fixed JEF thread table, copied verbatim.
//
// pystitch -> TS: EmbThreadJef -> EmbThreadJef; get_thread_set -> getThreadSet.
import { EmbThread } from "../core/thread";

export class EmbThreadJef extends EmbThread {
  constructor(color: number, description: string, catalogNumber: string) {
    super();
    this.color = color;
    this.description = description;
    this.catalogNumber = catalogNumber;
    this.brand = "Jef";
    this.chart = "Jef";
  }
}

/**
 * get_thread_set: a fresh table on every call (pystitch builds a new list each time, and the writer temporarily
 * blanks entries of it). Index 0 is the placeholder (null); there are 78 real entries.
 */
export function getThreadSet(): Array<EmbThreadJef | null> {
  return [
    null, // EmbThreadJef(0x000000, "Placeholder", "000"),
    new EmbThreadJef(0x000000, "Black", "002"),
    new EmbThreadJef(0xFFFFFF, "White", "001"),
    new EmbThreadJef(0xFFFF17, "Yellow", "204"),
    new EmbThreadJef(0xFF6600, "Orange", "203"),
    new EmbThreadJef(0x2F5933, "Olive Green", "219"),
    new EmbThreadJef(0x237336, "Green", "226"),
    new EmbThreadJef(0x65C2C8, "Sky", "217"),
    new EmbThreadJef(0xAB5A96, "Purple", "208"),
    new EmbThreadJef(0xF669A0, "Pink", "201"),
    new EmbThreadJef(0xFF0000, "Red", "225"),
    new EmbThreadJef(0xB1704E, "Brown", "214"),
    new EmbThreadJef(0x0B2F84, "Blue", "207"),
    new EmbThreadJef(0xE4C35D, "Gold", "003"),
    new EmbThreadJef(0x481A05, "Dark Brown", "205"),
    new EmbThreadJef(0xAC9CC7, "Pale Violet", "209"),
    new EmbThreadJef(0xFCF294, "Pale Yellow", "210"),
    new EmbThreadJef(0xF999B7, "Pale Pink", "211"),
    new EmbThreadJef(0xFAB381, "Peach", "212"),
    new EmbThreadJef(0xC9A480, "Beige", "213"),
    new EmbThreadJef(0x970533, "Wine Red", "215"),
    new EmbThreadJef(0xA0B8CC, "Pale Sky", "216"),
    new EmbThreadJef(0x7FC21C, "Yellow Green", "218"),
    new EmbThreadJef(0xE5E5E5, "Silver Gray", "220"),
    new EmbThreadJef(0x889B9B, "Gray", "221"),
    new EmbThreadJef(0x98D6BD, "Pale Aqua", "227"),
    new EmbThreadJef(0xB2E1E3, "Baby Blue", "228"),
    new EmbThreadJef(0x368BA0, "Powder Blue", "229"),
    new EmbThreadJef(0x4F83AB, "Bright Blue", "230"),
    new EmbThreadJef(0x386A91, "Slate Blue", "231"),
    new EmbThreadJef(0x071650, "Navy Blue", "232"),
    new EmbThreadJef(0xF999A2, "Salmon Pink", "233"),
    new EmbThreadJef(0xF9676B, "Coral", "234"),
    new EmbThreadJef(0xE3311F, "Burnt Orange", "235"),
    new EmbThreadJef(0xE2A188, "Cinnamon", "236"),
    new EmbThreadJef(0xB59474, "Umber", "237"),
    new EmbThreadJef(0xE4CF99, "Blond", "238"),
    new EmbThreadJef(0xFFCB00, "Sunflower", "239"),
    new EmbThreadJef(0xE1ADD4, "Orchid Pink", "240"),
    new EmbThreadJef(0xC3007E, "Peony Purple", "241"),
    new EmbThreadJef(0x80004B, "Burgundy", "242"),
    new EmbThreadJef(0x540571, "Royal Purple", "243"),
    new EmbThreadJef(0xB10525, "Cardinal Red", "244"),
    new EmbThreadJef(0xCAE0C0, "Opal Green", "245"),
    new EmbThreadJef(0x899856, "Moss Green", "246"),
    new EmbThreadJef(0x5C941A, "Meadow Green", "247"),
    new EmbThreadJef(0x003114, "Dark Green", "248"),
    new EmbThreadJef(0x5DAE94, "Aquamarine", "249"),
    new EmbThreadJef(0x4CBF8F, "Emerald Green", "250"),
    new EmbThreadJef(0x007772, "Peacock Green", "251"),
    new EmbThreadJef(0x595B61, "Dark Gray", "252"),
    new EmbThreadJef(0xFFFFF2, "Ivory White", "253"),
    new EmbThreadJef(0xB15818, "Hazel", "254"),
    new EmbThreadJef(0xCB8A07, "Toast", "255"),
    new EmbThreadJef(0x986C80, "Salmon", "256"),
    new EmbThreadJef(0x98692D, "Cocoa Brown", "257"),
    new EmbThreadJef(0x4D3419, "Sienna", "258"),
    new EmbThreadJef(0x4C330B, "Sepia", "259"),
    new EmbThreadJef(0x33200A, "Dark Sepia", "260"),
    new EmbThreadJef(0x523A97, "Violet Blue", "261"),
    new EmbThreadJef(0x0D217E, "Blue Ink", "262"),
    new EmbThreadJef(0x1E77AC, "Sola Blue", "263"),
    new EmbThreadJef(0xB2DD53, "Green Dust", "264"),
    new EmbThreadJef(0xF33689, "Crimson", "265"),
    new EmbThreadJef(0xDE649E, "Floral Pink", "266"),
    new EmbThreadJef(0x984161, "Wine", "267"),
    new EmbThreadJef(0x4C5612, "Olive Drab", "268"),
    new EmbThreadJef(0x4C881F, "Meadow", "269"),
    new EmbThreadJef(0xE4DE79, "Mustard", "270"),
    new EmbThreadJef(0xCB8A1A, "Yellow Ocher", "271"),
    new EmbThreadJef(0xCBA21C, "Old Gold", "272"),
    new EmbThreadJef(0xFF9805, "Honey Dew", "273"),
    new EmbThreadJef(0xFCB257, "Tangerine", "274"),
    new EmbThreadJef(0xFFE505, "Canary Yellow", "275"),
    new EmbThreadJef(0xF0331F, "Vermilion", "202"),
    new EmbThreadJef(0x1A842D, "Bright Green", "206"),
    new EmbThreadJef(0x386CAE, "Ocean Blue", "222"),
    new EmbThreadJef(0xE3C4B4, "Beige Gray", "223"),
    new EmbThreadJef(0xE3AC81, "Bamboo", "224"),
  ];
}
