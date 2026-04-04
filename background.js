// background.js — Service Worker
// Handles PDF fetching (CORS bypass) AND the full word-detection + API pipeline
// so scans continue running even if the user closes the popup.

importScripts('libs/commonwords.js'); // → self.COMMON_WORDS

// ── Constants ──────────────────────────────────────────────────────────────
const DICT_API        = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MAX_RESULTS     = 500;
const MAX_CANDIDATES  = 800;
const API_CONCURRENCY = 3;   // keep low — free API rate-limits aggressively
const MIN_WORD_LEN    = 7;

// ── Word-Detection Helpers ─────────────────────────────────────────────────

const NOISE_RE = /[^a-z]/;

const ALWAYS_SKIP = new Set([
  'ourselves','themselves','something','everything','anything','nothing',
  'someone','everyone','anyone','somewhere','everywhere','anywhere',
  'another','however','although','because','through','without',
  'between','different','together','children','national','government',
  'possible','probably','actually','important','including','following',
  'american','english','british','chapter','section','january',
  'february','october','november','december','saturday','thursday',
  'business','thousand','remember','political','economic',
  'education','standard','industry','language','continue',
  'personal','problem','example','usually','company','country',
  'question','program','history','million','whether',
  'already','general','quickly','himself','members','several',
  'percent','thought','system','university','president',
  'department','information','available','technology','development',
  'community','individual','sometimes','according','throughout',
  'environment','understand','companies','products',
  'services','research','students','working','looking',
  'building','becoming','creating','herself','yourself',
]);

function isHardWord(raw) {
  const w = raw.toLowerCase();
  if (w.length < MIN_WORD_LEN) return false;
  if (NOISE_RE.test(w)) return false;
  if (ALWAYS_SKIP.has(w)) return false;
  if (self.COMMON_WORDS.has(w)) return false;
  const stems = [
    w.endsWith('ing') && w.length > 10 ? w.slice(0, -3) : null,
    w.endsWith('ing') && w.length > 10 ? w.slice(0, -3) + 'e' : null,
    w.endsWith('tion') ? w.slice(0, -4) + 'te' : null,
    w.endsWith('ed')  ? w.slice(0, -2) : null,
    w.endsWith('ed')  ? w.slice(0, -1) : null,
    w.endsWith('ly')  ? w.slice(0, -2) : null,
    w.endsWith('er')  ? w.slice(0, -2) : null,
    w.endsWith('s')   ? w.slice(0, -1) : null,
  ];
  for (const stem of stems) {
    if (stem && stem.length >= MIN_WORD_LEN && self.COMMON_WORDS.has(stem)) return false;
  }
  return true;
}

function buildCapitalizationProfile(text) {
  const profile = new Map();
  const sentences = text.split(/(?:[.!?\n]+)\s*/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const words = trimmed.match(/\b[A-Za-z]+\b/g);
    if (!words) continue;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lw = word.toLowerCase();
      if (!profile.has(lw)) profile.set(lw, { capMid: 0, lower: 0 });
      const entry = profile.get(lw);
      if (i !== 0 && /^[A-Z]/.test(word)) entry.capMid++;
      else entry.lower++;
    }
  }
  return profile;
}

function isProperNoun(lowerWord, profile) {
  const entry = profile.get(lowerWord);
  return !!(entry && entry.capMid > 0);
}

const GARBAGE_RE = /https?:\/\/|www\.|facebook|linkedin|twitter|reddit|instagram|youtube|\d{2}:\d{2}|CopiedAuto|mailto:|cookie|subscribe|newsletter/i;

function extractSentences(text) {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => {
      if (s.length < 25 || s.length > 350) return false;
      if (GARBAGE_RE.test(s)) return false;
      const letters = (s.match(/[a-zA-Z ]/g) || []).length;
      if (letters / s.length < 0.65) return false;
      return true;
    });
}

function findContexts(baseWord, sentences, maxCtx = 3) {
  const re = new RegExp(`\\b${baseWord}\\w{0,10}\\b`, 'i');
  return sentences.filter(s => re.test(s)).slice(0, maxCtx);
}

function detectHardWords(text) {
  const sentences = extractSentences(text);
  const capProfile = buildCapitalizationProfile(text);
  const freq = new Map();
  const tokens = text.match(/\b[a-zA-Z]+\b/g) || [];
  for (const token of tokens) {
    if (!isHardWord(token)) continue;
    const key = token.toLowerCase();
    if (isProperNoun(key, capProfile)) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CANDIDATES)
    .map(([word]) => word);
  const seen = new Map();
  for (const word of sorted) {
    seen.set(word, findContexts(word, sentences));
  }
  return seen;
}

// ── Dictionary API ─────────────────────────────────────────────────────────

async function fetchDefinition(word, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(DICT_API + encodeURIComponent(word));
      if (res.status === 404) return null;
      if (res.status === 429 || !res.ok) {
        // Exponential backoff: 500ms, 1s, 2s before giving up
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        return undefined; // undefined = network/rate-limit failure, null = 404
      }
      const data = await res.json();
      const entry = data[0];
      const meaning = entry?.meanings?.[0];
      return {
        definition: meaning?.definitions?.[0]?.definition || '',
        pos:        meaning?.partOfSpeech || '',
        phonetic:   entry?.phonetic || '',
      };
    } catch {
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  return undefined;
}

async function batchFetchDefinitions(words, onProgress) {
  const keys = words.map(w => `dict_${w}`);
  const cachedData = await chrome.storage.local.get(keys);
  
  const results = {};
  const missingWords = [];
  
  // 1. Separate cached vs missing words
  for (const w of words) {
    const key = `dict_${w}`;
    if (cachedData[key]) {
      results[w] = cachedData[key].notFound ? null : cachedData[key];
    } else {
      missingWords.push(w);
    }
  }

  let pendingWords = [...missingWords];
  let pass = 1;
  const maxPasses = 3;

  // 2. Fetch missing words from API
  while (pendingWords.length > 0 && pass <= maxPasses) {
    const nextPending = [];
    const totalWords = missingWords.length;

    for (let i = 0; i < pendingWords.length; i += API_CONCURRENCY) {
      const chunk = pendingWords.slice(i, i + API_CONCURRENCY);
      const defs  = await Promise.all(chunk.map(w => fetchDefinition(w)));
      
      const toCache = {};

      chunk.forEach((w, j) => { 
        if (defs[j] === undefined) {
          nextPending.push(w);
        } else {
          results[w] = defs[j]; 
          toCache[`dict_${w}`] = defs[j] || { notFound: true, timestamp: Date.now() };
        }
      });

      // Save chunk to local storage immediately
      if (Object.keys(toCache).length > 0) {
        await chrome.storage.local.set(toCache);
      }

      if (onProgress) {
        const doneCount = totalWords - pendingWords.length + i + chunk.length;
        const passText = pass > 1 ? ` (retry pass ${pass})` : '';
        const totalKnown = words.length - missingWords.length;
        // Make it clear we're only fetching new words
        onProgress(`Fetching new words${passText}… (${Math.min(doneCount, totalWords)}/${totalWords}) — ${totalKnown} loaded from cache`);
      }

      if (i + API_CONCURRENCY < pendingWords.length) {
        // 400ms between chunks — gives the free API time to breathe
        await new Promise(r => setTimeout(r, 400));
      }
    }

    pendingWords = nextPending;
    pass++;
    if (pendingWords.length > 0 && pass <= maxPasses) {
      // Larger delay between passes if the API is overwhelmed
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return results;
}

// ── Deduplication ──────────────────────────────────────────────────────────

function deduplicateByTense(validWords, defs, wordMap) {
  const sorted = [...validWords].sort((a, b) => a.length - b.length);
  const assigned = new Set();
  const groups = [];
  const INFLECT_SUFFIXES = ['s','es','ed','ing','er','ers','est',
    'ly','ness','ment','ments','tion','tions','ize','izes','ized','izing'];

  for (const word of sorted) {
    if (assigned.has(word)) continue;
    const group = [word];
    assigned.add(word);
    for (const other of sorted) {
      if (assigned.has(other) || other.length <= word.length) continue;
      if (!other.startsWith(word)) continue;
      const suffix = other.slice(word.length);
      if (INFLECT_SUFFIXES.includes(suffix)) {
        group.push(other);
        assigned.add(other);
      }
    }
    groups.push(group);
  }

  const entries = [];
  for (const group of groups) {
    const canonical = group.find(w => defs[w]?.definition) || group[0];
    const ctxSeen = new Set();
    const allContexts = [];
    for (const word of group) {
      for (const ctx of (wordMap.get(word) || [])) {
        if (!ctxSeen.has(ctx)) { ctxSeen.add(ctx); allContexts.push(ctx); }
      }
    }
    const defObj = defs[canonical];
    if (!defObj?.definition) continue;
    entries.push({
      word:       canonical,
      definition: defObj.definition,
      pos:        defObj.pos || '',
      phonetic:   defObj.phonetic || '',
      contexts:   allContexts.slice(0, 5),
    });
  }
  return entries.sort((a, b) => a.word.localeCompare(b.word));
}

// ── Scan pipeline (runs independently of popup) ────────────────────────────

async function runScanPipeline({ text, source, tabId, tabUrl, isPDF }) {
  const setProgress = async (progress) => {
    try {
      await chrome.storage.session.set({
        scanSession: { status: 'scanning', progress, tabId, tabUrl, source, isPDF },
      });
    } catch (_) {}
  };

  try {
    await setProgress('Analyzing text…');

    const wordMap = detectHardWords(text);
    if (wordMap.size === 0) throw new Error('No advanced vocabulary detected.');

    await setProgress(`Found ${wordMap.size} candidates. Validating…`);

    const words = [...wordMap.keys()].sort();
    const defs  = await batchFetchDefinitions(words, msg => setProgress(msg));

    const validWords = words.filter(w => defs[w]?.definition);
    if (validWords.length === 0) throw new Error('No English vocabulary words with definitions found.');

    const dedupedEntries = deduplicateByTense(validWords, defs, wordMap);

    const results = dedupedEntries.slice(0, MAX_RESULTS).map(entry => ({
      word:       entry.word,
      definition: entry.definition,
      pos:        entry.pos,
      phonetic:   entry.phonetic,
      contexts:   entry.contexts,
      source,
      selected:   true,
    }));

    await chrome.storage.session.set({
      scanSession: { status: 'done', results, source, isPDF, tabId, tabUrl },
    });
  } catch (err) {
    await chrome.storage.session.set({
      scanSession: { status: 'error', error: err.message, tabId, tabUrl },
    }).catch(() => {});
  }
}

// ── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── PDF fetch (CORS bypass) ──
  if (message.action === 'fetchPDF') {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buffer => {
        sendResponse({ success: true, data: Array.from(new Uint8Array(buffer)) });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  // ── Word-scan pipeline ──
  // Awaiting runScanPipeline here is intentional: returning `true` from
  // onMessage tells Chrome to keep the service worker alive until sendResponse
  // is called. Without this, Chrome terminates the worker the moment the
  // synchronous part of the handler returns — killing the scan mid-flight.
  if (message.action === 'processText') {
    runScanPipeline(message).finally(() => {
      try { sendResponse({ done: true }); } catch (_) {}
    });
    return true; // MUST be here — signals async sendResponse to keep worker alive
  }
});

// ── Clear session when scanned tab navigates/reloads ──────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  chrome.storage.session.get('scanSession').then(stored => {
    if (stored.scanSession?.tabId === tabId) {
      chrome.storage.session.remove('scanSession');
    }
  }).catch(() => {});
});
