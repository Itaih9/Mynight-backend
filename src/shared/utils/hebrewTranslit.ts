/**
 * Hebrew → Latin transliteration for personal names, used to build the link a
 * couple gets (mynight.co.il/gallery/dana-yoav-...).
 *
 * Why this is not a character map: Hebrew is an abjad and does not write short
 * vowels. A one-letter-one-sound map turns דנה into "dnh" and דור into "dvr",
 * which is what the old implementation did — and every real couple then spent
 * their limited slug edits fixing the link by hand.
 *
 * Two layers, in order:
 *
 *   1. A table of common Israeli given names. Names are a closed-ish set, and
 *      their accepted spellings are conventions, not derivations — no algorithm
 *      recovers "binyamin" from ב-נ-י-מ-י-ן. When the name is in the table we
 *      use the spelling Israelis actually write.
 *
 *   2. A reconstruction pass for everything else, which reads ו and י as the
 *      vowels they usually are inside a name, gives final ה its "a", and
 *      supplies a default "a" between bare consonants. It gets דור→dor,
 *      גל→gal, נוי→noy and דורין→dorin right; it will not get every surname
 *      right, and it does not need to — a wrong-but-pronounceable link is
 *      still editable, and it is a long way better than "dvr".
 */

/**
 * Conventional spellings. Keys are bare Hebrew (no niqqud, no geresh).
 * Ordered roughly by how often they turn up on an Israeli wedding invitation.
 */
const NAME_SPELLINGS: Record<string, string> = {
  // — men —
  אבי: 'avi', אביב: 'aviv', אבנר: 'avner', אברהם: 'avraham', אדם: 'adam',
  אהרון: 'aharon', אופיר: 'ofir', אור: 'or', אורי: 'uri', אושר: 'osher',
  אייל: 'eyal', איל: 'eyal', איתי: 'itay', איתמר: 'itamar', איתן: 'eitan',
  אלון: 'alon', אלי: 'eli', אליאור: 'elior', אליהו: 'eliyahu', אלירן: 'eliran',
  אמיר: 'amir', אסף: 'asaf', ארז: 'erez', אריאל: 'ariel', אריה: 'arye',
  אשר: 'asher', בן: 'ben', בני: 'beni', בנימין: 'binyamin', בר: 'bar',
  ברק: 'barak', גד: 'gad', גיא: 'guy', גיל: 'gil', גילי: 'gili',
  גל: 'gal', גלעד: 'gilad', דביר: 'dvir', דוד: 'david', דור: 'dor',
  דורון: 'doron', דן: 'dan', דני: 'dani', דניאל: 'daniel', הראל: 'harel',
  זיו: 'ziv', חגי: 'hagai', חיים: 'haim', חן: 'chen', טל: 'tal',
  יאיר: 'yair', יהודה: 'yehuda', יהונתן: 'yehonatan', יובל: 'yuval', יוסי: 'yossi',
  יוסף: 'yosef', יונתן: 'yonatan', יעקב: 'yaakov', יריב: 'yariv', ישי: 'yishai',
  כפיר: 'kfir', לביא: 'lavi', לוי: 'levi', ליאור: 'lior', ליאם: 'liam',
  מאור: 'maor', מור: 'mor', מיכאל: 'michael', מנחם: 'menachem', משה: 'moshe',
  מתן: 'matan', נדב: 'nadav', נועם: 'noam', ניב: 'niv', נימרוד: 'nimrod',
  ניר: 'nir', נתן: 'natan', סהר: 'sahar', עדי: 'adi', עוז: 'oz',
  עומר: 'omer', עומרי: 'omri', עידן: 'idan', עמית: 'amit', עמרי: 'omri', ערן: 'eran',
  פלג: 'peleg', צחי: 'tzahi', קובי: 'kobi', רועי: 'roi', רון: 'ron',
  רותם: 'rotem', רז: 'raz', רן: 'ran', שגיא: 'sagi', שוהם: 'shoham',
  שחר: 'shahar', שי: 'shai', שלום: 'shalom', שלמה: 'shlomo', שמעון: 'shimon',
  שקד: 'shaked', תום: 'tom', תומר: 'tomer', תמיר: 'tamir',

  // — women —
  אביגיל: 'avigail', אדוה: 'adva', אודליה: 'odelia', אורית: 'orit', אושרית: 'oshrit',
  איילה: 'ayala', אילנה: 'ilana', אלה: 'ela', אליה: 'elia', אלין: 'alin',
  אנה: 'ana', אסתר: 'ester', אפרת: 'efrat', בתאל: 'batel', גאיה: 'gaya',
  גלי: 'gali', דורין: 'dorin', דנה: 'dana', דניאלה: 'daniela', הדס: 'hadas',
  הדר: 'hadar', הילה: 'hila', ורד: 'vered', זהר: 'zohar', חנה: 'hana',
  טליה: 'talia', יעל: 'yael', ירדן: 'yarden', כרמל: 'carmel', לי: 'lee',
  ליאל: 'liel', ליטל: 'lital', לילך: 'lilach', לימור: 'limor', לינוי: 'linoy',
  מאיה: 'maya', מיכל: 'michal', מירב: 'meirav', מלכה: 'malka', מעיין: 'maayan',
  מרים: 'miriam', נגה: 'noga', נוי: 'noy', נועה: 'noa', נטלי: 'natalie',
  ניקול: 'nicole', נירית: 'nirit', נעמה: 'naama', סיון: 'sivan', סתיו: 'stav',
  עדן: 'eden', עינב: 'einav', ענבל: 'inbal', ענבר: 'inbar', רבקה: 'rivka',
  רוני: 'roni', רחל: 'rachel', רינת: 'rinat', שירה: 'shira', שירן: 'shiran',
  שלי: 'shelly', שני: 'shani', שרה: 'sara', תהילה: 'tehila', תמר: 'tamar',
};

/** Consonants, by position. Several Hebrew letters soften away from the start. */
const INITIAL: Record<string, string> = {
  ב: 'b', כ: 'k', ך: 'k', פ: 'p', ף: 'f',
};
const CONSONANTS: Record<string, string> = {
  ב: 'v', ג: 'g', ד: 'd', ה: 'h', ז: 'z', ח: 'ch', ט: 't',
  כ: 'ch', ך: 'ch', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n',
  ס: 's', פ: 'f', ף: 'f', צ: 'tz', ץ: 'tz', ק: 'k', ר: 'r',
  ש: 'sh', ת: 't',
};

const isVowelSound = (s: string) => /[aeiou]$/.test(s);
const startsWithVowel = (s: string) => /^[aeiou]/.test(s);

/** Strip niqqud, geresh and other marks so lookups and rules see bare letters. */
const stripMarks = (text: string): string =>
  text.replace(/[֑-ׇ]/g, '').replace(/[׳״'"`]/g, '');

/**
 * Reconstruct a plausible pronunciation for a name we have no spelling for.
 * Deliberately biased toward "readable" over "scholarly": this feeds a URL.
 */
const reconstruct = (word: string): string => {
  const chars = [...word];
  const parts: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const first = i === 0;
    const last = i === chars.length - 1;
    const next = chars[i + 1];

    if (c === 'ו') {
      // Doubled vav is the consonant; otherwise it is the vowel o/u, except
      // at the very start of a word where it reads as "v".
      if (next === 'ו') { parts.push('v'); i++; }
      else if (first) parts.push('v');
      else parts.push('o');
      continue;
    }

    if (c === 'י') {
      // Leading yod is "y" (yael, yuval). Inside a word it is the vowel i,
      // and a doubled yod is the "ay" of ayala.
      if (next === 'י') { parts.push('ay'); i++; }
      else if (first) parts.push('y');
      else parts.push('i');
      continue;
    }

    if (c === 'ה') {
      // Final he is the "a" that ends dana, shira, noga — never an "h".
      parts.push(last ? 'a' : 'h');
      continue;
    }

    if (c === 'א') {
      // Silent before a vowel letter (oshrit, not aoshrit) and at the end.
      if (first && (next === 'ו' || next === 'י')) continue;
      if (last) continue;
      parts.push('a');
      continue;
    }

    if (c === 'ע') {
      // Ayin has no English sound. It carries a vowel of its own in most names
      // (naama, adi), but when it opens a word in front of a vowel letter that
      // vowel is the one you hear — omri, not aomri.
      if (first && (next === 'ו' || next === 'י')) continue;
      parts.push('a');
      continue;
    }

    const mapped = (first && INITIAL[c]) || CONSONANTS[c];
    if (mapped) parts.push(mapped);
    else if (/[a-z0-9]/i.test(c)) parts.push(c.toLowerCase());
  }

  // Supply the vowels the script never wrote: between two bare consonants,
  // "a" is the safest guess (gal, dani, tamar, shachar).
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    const prev = parts[i - 1];
    if (prev && !isVowelSound(prev) && !startsWithVowel(cur)) out += 'a';
    out += cur;
  }
  return out;
};

/**
 * One name (possibly several words) to lowercase Latin letters, hyphen-joined.
 * Non-Hebrew input is passed through, so "Emily" stays "emily".
 */
export const transliterateHebrewName = (name: string): string =>
  stripMarks(name || '')
    .trim()
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((word) => {
      const known = NAME_SPELLINGS[word];
      if (known) return known;
      // Nothing Hebrew in it — it is already Latin, just normalise it.
      if (!/[א-ת]/.test(word)) return word.toLowerCase().replace(/[^a-z0-9]/g, '');
      return reconstruct(word).replace(/[^a-z0-9]/g, '');
    })
    .filter(Boolean)
    .join('-');

/** Exposed for tests and for anything that wants to check coverage. */
export const KNOWN_NAME_COUNT = Object.keys(NAME_SPELLINGS).length;
