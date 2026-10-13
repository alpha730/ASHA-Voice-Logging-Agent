// Browser text-to-speech helpers.
//
// A Hindi (hi-IN) voice reads Latin-script text letter by letter ("agli" -> "A G L I"),
// and an English voice cannot read Devanagari. So each sentence is split into runs by
// script and every run is spoken with a voice that can actually read it.

export type SpeechChunk = { text: string; lang: "hi-IN" | "en-IN" };

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;

export function splitBySpeechLang(text: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let current: SpeechChunk | null = null;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const lang: "hi-IN" | "en-IN" | null = DEVANAGARI.test(part) ? "hi-IN" : LATIN.test(part) ? "en-IN" : null;
    if (!current) current = { text: part, lang: lang ?? "en-IN" };
    else if (lang === null || lang === current.lang || /^\s+$/.test(part)) current.text += part;
    else {
      chunks.push(current);
      current = { text: part, lang };
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => /[\p{L}\p{N}]/u.test(c.text));
}

export function pickVoice(lang: "hi-IN" | "en-IN"): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const base = lang.slice(0, 2);
  return (
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase()) ??
    (lang === "en-IN" ? voices.find((v) => v.lang.startsWith("en")) : voices.find((v) => v.lang.startsWith(base)))
  );
}
