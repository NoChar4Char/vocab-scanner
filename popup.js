// popup.js — Vocab Scanner Main Logic
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MAX_RESULTS    = 100; // Max words shown per scan (after definition filter)
const MAX_CANDIDATES = 200; // Candidate pool before API validation
const API_CONCURRENCY = 8;  // Parallel dictionary lookups
const MIN_WORD_LEN = 7;     // Minimum chars to be considered "hard"

// ── State ──────────────────────────────────────────────────────────────────
let currentResults = []; // [{word, definition, pos, phonetic, contexts, selected}]
let currentSource = '';

// ── DOM refs ───────────────────────────────────────────────────────────────
const scanBtn     = document.getElementById('scanBtn');
const scanText    = document.getElementById('scanText');
const statusMsg   = document.getElementById('statusMsg');
const wordListEl  = document.getElementById('wordList');
const emptyState  = document.getElementById('emptyState');
const statsBar    = document.getElementById('statsBar');
const sourceBar   = document.getElementById('sourceBar');
const sourceLabel = document.getElementById('sourceLabel');
const sourceType  = document.getElementById('sourceType');
const footer      = document.getElementById('footer');
const saveBtn     = document.getElementById('saveBtn');
const scanPdfBtn  = document.getElementById('scanPdfBtn');
const masterBtn   = document.getElementById('masterBtn');
const clearBtn    = document.getElementById('clearBtn');
const wordCountEl = document.getElementById('wordCount');
const savedCountEl= document.getElementById('savedCount');
const selectAll   = document.getElementById('selectAll');
const deselectAll = document.getElementById('deselectAll');

// ── Word Detection (Inverse / Exclusion Approach) ────────────────────────────
// Strategy: flag any word that is long enough AND not in the 20k common-words
// exclusion list. This naturally captures tens of thousands of advanced words
// without needing to enumerate them.

// Words that look like proper nouns, codes, or noise — quick reject patterns
const NOISE_RE = /[^a-z]/;          // any non-alpha char after lowercasing
const ALWAYS_SKIP = new Set([
  // Short function words that survive the length filter
  'ourselves','themselves','something','everything','anything','nothing',
  'someone','everyone','anyone','somewhere','everywhere','anywhere',
  'another','however','although','because','through','without',
  'between','different','together','children','national','government',
  'possible','probably','actually','important','including','following',
  'american','english','british','chapter','section','january',
  'february','october','november','december','saturday','thursday',
  'following','business','thousand','remember','political','economic',
  'education','standard','industry','language','continue','everyone',
  'personal','problem','example','usually','company','country',
  'question','program','history','million','whether','nothing',
  'already','general','quickly','himself','members','several',
  'percent','thought','system','university','president',
  'department','information','available','technology','development',
  'community','individual','sometimes','according','throughout',
  'environment','understand','companies','together','products',
  'services','research','students','children','working','looking',
  'building','becoming','creating','himself','herself','yourself',
]);

function isHardWord(raw) {
  const w = raw.toLowerCase();
  // Must be long enough
  if (w.length < MIN_WORD_LEN) return false;
  // Must be pure alpha
  if (NOISE_RE.test(w)) return false;
  // Skip words in our "always skip" override set
  if (ALWAYS_SKIP.has(w)) return false;
  // The core rule: NOT in the 20k most common English words
  if (window.COMMON_WORDS.has(w)) return false;
  // Also check common inflections: strip -s, -ed, -ing, -ly, -er
  const stems = [
    w.endsWith('ing') && w.length > 10 ? w.slice(0, -3) : null,
    w.endsWith('ing') && w.length > 10 ? w.slice(0, -3) + 'e' : null,
    w.endsWith('tion') ? w.slice(0, -4) + 'te' : null,
    w.endsWith('ed') ? w.slice(0, -2) : null,
    w.endsWith('ed') ? w.slice(0, -1) : null,
    w.endsWith('ly') ? w.slice(0, -2) : null,
    w.endsWith('er') ? w.slice(0, -2) : null,
    w.endsWith('s')  ? w.slice(0, -1) : null,
  ];
  for (const stem of stems) {
    if (stem && stem.length >= MIN_WORD_LEN && window.COMMON_WORDS.has(stem)) return false;
  }
  return true;
}

// Return the "canonical" form of a word for deduplication
// (we keep the shortest form seen so the display word looks clean)
function canonicalize(raw) {
  return raw.toLowerCase();
}

// ── Proper Noun Detection (Capitalization Ratio) ───────────────────────────
// For every word we walk each sentence. If the word appears at a
// NON-sentence-start position and is capitalized, that's evidence it is a
// proper noun. We tally capMid vs. lower occurrences per word.
// Threshold: >65% capitalized mid-sentence → likely proper noun.

function buildCapitalizationProfile(text) {
  const profile = new Map(); // lowercase → { capMid: n, lower: n }

  // Split into rough sentences on . ! ? newline
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
      const isCap = /^[A-Z]/.test(word);
      const isSentenceStart = i === 0;

      if (!isSentenceStart && isCap) {
        entry.capMid++;
      } else {
        entry.lower++;
      }
    }
  }
  return profile;
}

function isProperNoun(lowerWord, profile) {
  const entry = profile.get(lowerWord);
  if (!entry) return false;
  // Strict rule: if the word is EVER capitalized mid-sentence, it's a proper noun.
  // Real vocabulary words are virtually never capitalized mid-sentence.
  return entry.capMid > 0;
}

// Garbage patterns that sneak in from page scraping (social links, video timecodes, etc.)
const GARBAGE_RE = /https?:\/\/|www\.|facebook|linkedin|twitter|reddit|instagram|youtube|\d{2}:\d{2}|CopiedAuto|mailto:|cookie|subscribe|newsletter/i;

function extractSentences(text) {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => {
      if (s.length < 25 || s.length > 350) return false;
      if (GARBAGE_RE.test(s)) return false;
      // Reject lines where less than 65% of chars are letters/spaces (URL noise, codes)
      const letters = (s.match(/[a-zA-Z ]/g) || []).length;
      if (letters / s.length < 0.65) return false;
      return true;
    });
}

function findContexts(baseWord, sentences, maxCtx = 3) {
  const re = new RegExp(`\\b${baseWord}\\w{0,10}\\b`, 'i');
  return sentences.filter(s => re.test(s)).slice(0, maxCtx);
}

// ── Stem-based Deduplication ──────────────────────────────────────────────────
// Groups inflected/plural variants under one canonical base form.
// "airstrikes" + "airstrike" → canonical "airstrike", merged contexts.
// "accorded" + "accords" + "according" → canonical "accord", merged contexts.

function getStem(word) {
  const w = word.toLowerCase();
  // Rules ordered longest-suffix-first to avoid partial matches.
  const rules = [
    [/izations?$/,  ''], [/isations?$/, ''],
    [/ations$/,  'ate'], [/ation$/,   'ate'],
    [/nesses$/,    ''], [/ness$/,       ''],
    [/ments$/,     ''], [/ment$/,       ''],
    [/ances$/,     ''], [/ance$/,       ''],
    [/ences$/,     ''], [/ence$/,       ''],
    [/ities$/,     ''], [/ity$/,        ''],
    [/ives$/,      ''], [/ive$/,        ''],
    [/ables$/,     ''], [/able$/,       ''],
    [/ibles$/,     ''], [/ible$/,       ''],
    [/izing$/,  'ize'], [/ising$/,   'ise'],
    [/ized$/,   'ize'], [/ised$/,    'ise'],
    [/izes$/,   'ize'], [/ises$/,    'ise'],
    [/ize$/,       ''], [/ise$/,        ''],
    [/ings$/,      ''], [/ing$/,        ''],
    [/ated$/,  'ate'], [/ates$/,    'ate'], [/ating$/, 'ate'],
    [/ously$/,     ''], [/ous$/,        ''],
    [/fully$/,     ''], [/ful$/,        ''],
    [/lessly$/,    ''], [/less$/,       ''],
    [/ally$/,      ''],
    [/ers$/,       ''], [/er$/,         ''],
    [/est$/,       ''], [/edly$/,       ''],
    [/ed$/,        ''], [/ly$/,         ''],
    [/ies$/,       'y'], [/es$/,        ''],
    [/s$/,         ''],
  ];
  for (const [re, repl] of rules) {
    const m = w.match(re);
    if (m && w.length - m[0].length >= 4) {
      return w.slice(0, w.length - m[0].length) + repl;
    }
  }
  return w;
}

// After API validation, group words by stem and merge contexts.
// Returns a flat array of deduplicated entry objects.
function deduplicateByTense(validWords, defs, wordMap) {
  const stemGroups = new Map(); // stem → [words]
  for (const word of validWords) {
    const stem = getStem(word);
    if (!stemGroups.has(stem)) stemGroups.set(stem, []);
    stemGroups.get(stem).push(word);
  }

  const entries = [];
  for (const group of stemGroups.values()) {
    // Pick canonical = shortest word in the group that has a definition
    group.sort((a, b) => a.length - b.length);
    const canonical = group.find(w => defs[w]?.definition) || group[0];

    // Merge all context sentences from all variants, deduplicating
    const ctxSeen = new Set();
    const allContexts = [];
    for (const word of group) {
      for (const ctx of (wordMap.get(word) || [])) {
        if (!ctxSeen.has(ctx)) { ctxSeen.add(ctx); allContexts.push(ctx); }
      }
    }

    entries.push({
      word:       canonical,
      definition: defs[canonical].definition,
      pos:        defs[canonical].pos || '',
      phonetic:   defs[canonical].phonetic || '',
      contexts:   allContexts.slice(0, 5), // up to 5 merged context sentences
    });
  }

  // Re-sort alphabetically after dedup
  return entries.sort((a, b) => a.word.localeCompare(b.word));
}

function detectHardWords(text) {
  const sentences = extractSentences(text);

  // Build capitalization profile from the RAW text (preserves case)
  const capProfile = buildCapitalizationProfile(text);

  // Track frequency of each hard, non-proper-noun word
  const freq = new Map();
  const tokens = text.match(/\b[a-zA-Z]+\b/g) || [];

  for (const token of tokens) {
    if (!isHardWord(token)) continue;
    const key = canonicalize(token);
    // Strict: any mid-sentence capitalization → proper noun → skip
    if (isProperNoun(key, capProfile)) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  // Sort: most-frequent hard words first, then alphabetically.
  // Use MAX_CANDIDATES here — we'll trim to MAX_RESULTS after API filtering.
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CANDIDATES)
    .map(([word]) => word);

  const seen = new Map();
  for (const word of sorted) {
    const contexts = findContexts(word, sentences);
    seen.set(word, contexts);
  }

  return seen; // Map<word, contexts[]>
}

// ── Dictionary API ─────────────────────────────────────────────────────────

async function fetchDefinition(word) {
  try {
    const res = await fetch(DICT_API + encodeURIComponent(word));
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data[0];
    const meaning = entry?.meanings?.[0];
    return {
      definition: meaning?.definitions?.[0]?.definition || '',
      pos: meaning?.partOfSpeech || '',
      phonetic: entry?.phonetic || '',
    };
  } catch { return null; }
}

async function batchFetchDefinitions(words) {
  const results = {};
  // Process in chunks of API_CONCURRENCY
  for (let i = 0; i < words.length; i += API_CONCURRENCY) {
    const chunk = words.slice(i, i + API_CONCURRENCY);
    const defs = await Promise.all(chunk.map(w => fetchDefinition(w)));
    chunk.forEach((w, j) => { results[w] = defs[j]; });
    setStatus(`Fetching definitions… (${Math.min(i + API_CONCURRENCY, words.length)}/${words.length})`);
  }
  return results;
}

// ── PDF Parsing ────────────────────────────────────────────────────────────

async function extractPDFText(url) {
  setStatus('Fetching PDF…');
  const response = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'fetchPDF', url }, resolve);
  });

  if (!response?.success) throw new Error(response?.error || 'PDF fetch failed');

  setStatus('Parsing PDF…');
  const uint8 = new Uint8Array(response.data);

  // pdf.js needs a workerSrc
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
    const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 50); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(it => it.str).join(' '));
    }
    return pages.join('\n');
  }
  throw new Error('pdf.js not loaded');
}

// ── Scanning ───────────────────────────────────────────────────────────────

async function scanPage() {
  setScanningState(true);
  currentResults = [];
  renderWordList([]);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    setStatus('Extracting text…');
    const data = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action: 'extractText' }, resolve);
    });

    if (!data) throw new Error('Could not extract page content.');

    let text = '';
    currentSource = data.source || tab.url;
    setSource(currentSource, data.type === 'pdf');

    if (data.type === 'pdf') {
      text = await extractPDFText(data.url);
    } else {
      text = data.text;
    }

    if (!text || text.length < 50) throw new Error('Not enough text found on this page.');

    setStatus(`Processing ${text.split(/\s+/).length.toLocaleString()} words…`);

    const wordMap = detectHardWords(text);
    if (wordMap.size === 0) throw new Error('No advanced vocabulary detected.');

    setStatus(`Found ${wordMap.size} candidates. Validating & deduplicating…`);
    const words = [...wordMap.keys()].sort();
    const defs = await batchFetchDefinitions(words);

    // Keep only words with a real English dictionary definition
    const validWords = words.filter(w => defs[w]?.definition);
    if (validWords.length === 0) throw new Error('No English vocabulary words with definitions found on this page.');

    // Merge tense/plural variants under one canonical base form
    const dedupedEntries = deduplicateByTense(validWords, defs, wordMap);

    currentResults = dedupedEntries.slice(0, MAX_RESULTS).map(entry => ({
      word:       entry.word,
      definition: entry.definition,
      pos:        entry.pos,
      phonetic:   entry.phonetic,
      contexts:   entry.contexts,
      source:     currentSource,
      selected:   true,
    }));

    renderWordList(currentResults);
    updateStats();
    setStatus('');

    // Persist results so popup can reopen without re-scanning the same tab
    try {
      const [tab2] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.session.set({
        scanSession: {
          tabId:   tab2.id,
          tabUrl:  tab2.url,
          results: currentResults,
          source:  currentSource,
          isPDF:   data.type === 'pdf',
        }
      });
    } catch (_) { /* session storage unavailable on older Chrome */ }
  } catch (err) {
    setStatus('⚠ ' + err.message);
  } finally {
    setScanningState(false);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

function highlightWord(sentence, word) {
  const re = new RegExp(`(\\b${word}\\w{0,10}\\b)`, 'gi');
  return sentence.replace(re, '<span class="highlight">$1</span>');
}

function renderWordList(results) {
  wordListEl.innerHTML = '';

  if (!results.length) {
    emptyState.classList.remove('hidden');
    statsBar.classList.add('hidden');
    footer.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  statsBar.classList.remove('hidden');
  footer.classList.remove('hidden');

  for (const item of results) {
    const card = document.createElement('div');
    card.className = 'word-card' + (item.selected ? '' : ' deselected');
    card.dataset.word = item.word;

    const contextHTML = item.contexts
      .map(ctx => `<div class="card-context">${highlightWord(ctx, item.word)}</div>`)
      .join('');

    card.innerHTML = `
      <input type="checkbox" class="card-check" ${item.selected ? 'checked' : ''} />
      <div class="card-body">
        <div class="card-top">
          <span class="card-word">${item.word}</span>
          ${item.pos ? `<span class="card-pos">${item.pos}</span>` : ''}
          ${item.phonetic ? `<span class="card-phonetic">${item.phonetic}</span>` : ''}
        </div>
        <div class="card-def">${item.definition}</div>
        ${contextHTML}
        <div class="card-source">${item.source}</div>
      </div>
    `;

    card.querySelector('.card-check').addEventListener('change', e => {
      item.selected = e.target.checked;
      card.classList.toggle('deselected', !item.selected);
      updateStats();
    });

    wordListEl.appendChild(card);
  }
}

// ── UI Helpers ─────────────────────────────────────────────────────────────

function setScanningState(scanning) {
  scanBtn.disabled = scanning;
  scanText.textContent = scanning ? 'Scanning…' : 'Scan Page';
}

function setStatus(msg) { statusMsg.textContent = msg; }
function setSource(src, isPDF = false) {
  sourceBar.classList.remove('hidden');
  sourceLabel.textContent = src;
  sourceType.textContent = isPDF ? 'PDF' : 'WEB';
}

async function updateStats() {
  wordCountEl.textContent = `${currentResults.length} words found`;
  const stored = await chrome.storage.local.get('masterWords');
  const master = stored.masterWords || {};
  savedCountEl.textContent = `${Object.keys(master).length} saved total`;
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ── Select All / None ──────────────────────────────────────────────────────

selectAll.addEventListener('click', () => {
  currentResults.forEach(r => { r.selected = true; });
  document.querySelectorAll('.card-check').forEach(cb => { cb.checked = true; });
  document.querySelectorAll('.word-card').forEach(c => c.classList.remove('deselected'));
  updateStats();
});

deselectAll.addEventListener('click', () => {
  currentResults.forEach(r => { r.selected = false; });
  document.querySelectorAll('.card-check').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.word-card').forEach(c => c.classList.add('deselected'));
  updateStats();
});

// ── Save to Master ─────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const toSave = currentResults.filter(r => r.selected);
  if (!toSave.length) { showToast('No words selected!'); return; }

  const stored = await chrome.storage.local.get('masterWords');
  const master = stored.masterWords || {};

  for (const item of toSave) {
    if (!master[item.word]) {
      master[item.word] = {
        word: item.word,
        definition: item.definition,
        pos: item.pos,
        phonetic: item.phonetic,
        occurrences: [],
      };
    }
    // Merge contexts (avoid exact duplicates)
    for (const ctx of item.contexts) {
      const exists = master[item.word].occurrences.some(o => o.sentence === ctx);
      if (!exists) {
        master[item.word].occurrences.push({ source: item.source, sentence: ctx });
      }
    }
  }

  await chrome.storage.local.set({ masterWords: master });
  showToast(`Saved ${toSave.length} word${toSave.length !== 1 ? 's' : ''} to master list`);
  updateStats();
});

// ── PDF Generation ─────────────────────────────────────────────────────────

function buildPDFDoc(entries, title) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W   = doc.internal.pageSize.getWidth();
  const H   = doc.internal.pageSize.getHeight();
  const ML  = 56, MR = 56;
  const CW  = W - ML - MR;
  let y     = 0;
  let pageNum = 0;

  function rgb(r,g,b)  { doc.setTextColor(r,g,b); }
  function fill(r,g,b) { doc.setFillColor(r,g,b); }
  function draw(r,g,b) { doc.setDrawColor(r,g,b); }

  function drawPageChrome() {
    pageNum++;
    // Light header rule
    draw(200, 202, 228); doc.setLineWidth(0.4);
    doc.line(ML, 32, W - MR, 32);
    // Header text
    doc.setFontSize(7.5).setFont(undefined, 'normal');
    rgb(170, 172, 195);
    doc.text('VOCAB SCANNER', ML, 24);
    doc.text(title.toUpperCase(), W / 2, 24, { align: 'center' });
    doc.text(String(pageNum), W - MR, 24, { align: 'right' });
    // Footer rule + text
    draw(215, 217, 235); doc.setLineWidth(0.3);
    doc.line(ML, H - 26, W - MR, H - 26);
    rgb(185, 187, 205); doc.setFontSize(7);
    doc.text('Generated ' + new Date().toLocaleDateString(), W / 2, H - 14, { align: 'center' });
    y = 54;
  }

  function newPage() { doc.addPage(); drawPageChrome(); }
  function checkY(need) { if (y + need > H - 42) newPage(); }

  // Start on page 1 directly — no cover page
  drawPageChrome();

  for (const entry of entries) {
    checkY(90);

    // Word heading
    doc.setFont(undefined, 'bold');
    doc.setFontSize(14); rgb(72, 78, 210);
    doc.text(entry.word, ML, y);

    // POS badge inline
    if (entry.pos) {
      const wx = doc.getTextWidth(entry.word);
      const posTxt = entry.pos.toUpperCase();
      doc.setFontSize(7.5).setFont(undefined, 'normal');
      const pw = doc.getTextWidth(posTxt) + 8;
      fill(232, 230, 250); doc.roundedRect(ML + wx + 8, y - 10, pw, 12, 2, 2, 'F');
      rgb(110, 80, 195);
      doc.text(posTxt, ML + wx + 12, y - 1);
    }
    y += 4;

    // Phonetic — strip non-ASCII (jsPDF built-in fonts don't support IPA)
    if (entry.phonetic) {
      const safe = entry.phonetic.replace(/[^\x20-\x7E]/g, '').trim();
      if (safe.length > 1) {
        doc.setFontSize(9).setFont(undefined, 'italic'); rgb(155, 158, 185);
        doc.text(safe, ML, y + 4);
        y += 14;
      }
    }

    // Thin rule under word (light, not prominent)
    draw(218, 220, 240); doc.setLineWidth(0.35);
    doc.line(ML, y + 4, W - MR, y + 4);
    y += 14;

    // Definition
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10); rgb(40, 44, 68);
    const defLines = doc.splitTextToSize(entry.definition, CW);
    checkY(defLines.length * 14 + 6);
    doc.text(defLines, ML, y);
    y += defLines.length * 14 + 8; // gap before context boxes

    // Context sentences
    const occs = entry.occurrences
      || (entry.contexts || []).map(s => ({ sentence: s, source: entry.source || '' }));

    for (const occ of occs.slice(0, 5)) {
      const txt = '\u201c' + occ.sentence.replace(/"/g, ' ') + '\u201d';
      // Set font FIRST so splitTextToSize uses correct 9pt character widths
      doc.setFontSize(9).setFont(undefined, 'italic'); rgb(55, 62, 108);
      // Left 16pt + right 20pt padding inside box
      const ctxLines = doc.splitTextToSize(txt, CW - 36);
      // jsPDF renders 9pt text at 9 × 1.15 ≈ 10.4pt per line; 5pt top + 5pt bottom pad
      const bH = Math.ceil(ctxLines.length * 10.4 + 14); // +4 to give equal top & bottom visual gap
      checkY(bH + 16);

      fill(246, 247, 254); draw(208, 211, 240); doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, bH, 2, 2, 'FD');
      fill(91, 95, 220); doc.rect(ML, y, 3, bH, 'F');

      doc.text(ctxLines, ML + 16, y + 11); // y+11 matches the bottom breathing room visually
      y += bH + 5;

      if (occ.source) {
        doc.setFontSize(7.5).setFont(undefined, 'normal'); rgb(160, 163, 188);
        const src = occ.source.length > 70 ? occ.source.slice(0, 67) + '\u2026' : occ.source;
        doc.text('\u2014 ' + src, ML + 12, y + 2);
        y += 15;
      }
      y += 6; // gap between context boxes
    }

    y += 16; // whitespace between entries
  }

  return doc;
}


// Per-scan PDF
scanPdfBtn.addEventListener('click', () => {
  const toExport = currentResults.filter(r => r.selected);
  if (!toExport.length) { showToast('No words selected!'); return; }
  const doc = buildPDFDoc(toExport, `Scan — ${currentSource}`);
  const date = new Date().toISOString().slice(0, 10);
  doc.save(`vocab-scan-${date}.pdf`);
});

// Clear master list
clearBtn.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('masterWords');
  const master = stored.masterWords || {};
  const count = Object.keys(master).length;

  if (count === 0) { showToast('Master list is already empty.'); return; }

  // Two-step confirmation — make the irreversibility explicit
  const confirmed = window.confirm(
    `Clear master list?\n\nThis will permanently delete all ${count} saved word${count !== 1 ? 's' : ''}.\nThis action cannot be undone.\n\nClick OK to confirm.`
  );
  if (!confirmed) return;

  await chrome.storage.local.remove('masterWords');
  showToast(`Deleted ${count} word${count !== 1 ? 's' : ''} from master list.`);
  updateStats();
});

// Master PDF
masterBtn.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('masterWords');
  const master = stored.masterWords || {};
  const entries = Object.values(master).sort((a, b) => a.word.localeCompare(b.word));
  if (!entries.length) { showToast('Master list is empty — save some words first!'); return; }
  masterBtn.textContent = 'Generating…';
  masterBtn.disabled = true;
  setTimeout(() => {
    const doc = buildPDFDoc(entries, 'Master Vocabulary List');
    doc.save('vocab-master.pdf');
    masterBtn.textContent = 'Master PDF';
    masterBtn.disabled = false;
  }, 50);
});

// ── Init ───────────────────────────────────────────────────────────────────

scanBtn.addEventListener('click', scanPage);
updateStats();

// Restore previous scan session if popup reopened on the same tab
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const stored = await chrome.storage.session.get('scanSession');
    const s = stored.scanSession;
    if (s && s.tabId === tab.id && s.tabUrl === tab.url && s.results?.length) {
      currentResults = s.results;
      currentSource  = s.source;
      setSource(currentSource, s.isPDF);
      renderWordList(currentResults);
      updateStats();
    }
  } catch (_) { /* ignore — storage.session unavailable or tab query failed */ }
})();
