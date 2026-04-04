// popup.js — Vocab Scanner Main Logic
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
// Word detection, API calls, and deduplication all run in background.js.
// Popup only handles text extraction (PDF.js) and UI rendering.
let currentResults = [];
let currentSource  = '';

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
// Text extraction stays in popup (needs pdf.js running here).
// Everything after that is handed to background.js, which runs independently
// so closing the popup mid-scan does NOT stop it.

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

    // Mark session as scanning so we can restore progress if popup is reopened
    await chrome.storage.session.set({
      scanSession: {
        status: 'scanning',
        progress: 'Starting analysis…',
        tabId: tab.id,
        tabUrl: tab.url,
        source: currentSource,
        isPDF: data.type === 'pdf',
      }
    }).catch(() => {});

    setStatus('Scanning\u2026 (safe to close this popup)');

    // Hand off to background — it runs independently of popup lifecycle.
    // Results come back via chrome.storage.onChanged (listener below).
    // The no-op callback is REQUIRED: without it Chrome never opens the response
    // channel, so the background's `return true` + sendResponse trick cannot keep
    // the service worker alive and the scan dies immediately.
    chrome.runtime.sendMessage({
      action: 'processText',
      text,
      source: currentSource,
      tabId:  tab.id,
      tabUrl: tab.url,
      isPDF:  data.type === 'pdf',
    }, () => { void chrome.runtime.lastError; });
    // Do NOT await — background fires-and-forgets.
    // setScanningState(false) is called by onChanged when background finishes.

  } catch (err) {
    setStatus('\u26a0 ' + err.message);
    setScanningState(false);
  }
  // Note: no finally { setScanningState(false) } here —
  // that happens via the storage.onChanged listener when background is done.
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

// Live listener: background updates storage.session as it scans.
// This fires whether popup was open the whole time or just reopened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.scanSession) return;
  const s = changes.scanSession.newValue;
  if (!s) return;

  if (s.status === 'scanning') {
    setScanningState(true);
    setStatus(s.progress || 'Scanning\u2026');
    if (s.source && !currentSource) {
      currentSource = s.source;
      setSource(currentSource, s.isPDF);
    }
  } else if (s.status === 'done') {
    currentResults = s.results || [];
    currentSource  = s.source || '';
    if (currentSource) setSource(currentSource, s.isPDF);
    renderWordList(currentResults);
    updateStats();
    setStatus('');
    setScanningState(false);
  } else if (s.status === 'error') {
    setStatus('\u26a0 ' + (s.error || 'Scan failed'));
    setScanningState(false);
  }
});

// On open: restore completed result OR re-attach to an in-progress scan.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const stored = await chrome.storage.session.get('scanSession');
    const s = stored.scanSession;
    if (!s || s.tabId !== tab.id) return;

    if (s.status === 'done' && s.results?.length) {
      currentResults = s.results;
      currentSource  = s.source || '';
      setSource(currentSource, s.isPDF);
      renderWordList(currentResults);
      updateStats();
    } else if (s.status === 'scanning') {
      // Background is still running — show current progress and wait
      currentSource = s.source || '';
      if (currentSource) setSource(currentSource, s.isPDF);
      setScanningState(true);
      setStatus(s.progress || 'Scanning\u2026');
      // onChanged will fire when background completes
    }
  } catch (_) { /* storage.session unavailable or tab query failed */ }
})();
