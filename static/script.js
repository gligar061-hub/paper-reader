/* ════════════════════════════════════════
   PDF.js
════════════════════════════════════════ */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const PAGE_GAP = 10;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

/* ════════════════════════════════════════
   State
════════════════════════════════════════ */
let pdfDoc          = null;
let pdfZoom         = 1.0;      // user zoom multiplier (1 = fit width)
let pageOffsets     = [];       // cumulative Y (px) start of each page
let lastRenderedPage = -1;      // tracks page dividers in Chinese panel
let zhVisible       = true;     // whether the Chinese translation panel is shown
let allSegments     = [];       // all paragraph segments accumulated for standalone ann mode
let isScrollSyncing = false;    // prevents scroll sync loop between PDF and standalone ann

/* ════════════════════════════════════════
   DOM refs
════════════════════════════════════════ */
const uploadForm   = document.getElementById('uploadForm');
const fileInput    = document.getElementById('fileInput');
const fileNameEl   = document.getElementById('fileName');
const apiKeyInput  = document.getElementById('apiKey');
const toggleKey    = document.getElementById('toggleKey');
const analyzeBtn   = document.getElementById('analyzeBtn');
const progressBox  = document.getElementById('progressBox');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const emptyState   = document.getElementById('emptyState');
const readerLayout = document.getElementById('readerLayout');
const pdfScroll    = document.getElementById('pdfScroll');
const pdfViewer    = document.getElementById('pdfViewer');
const zhScroll     = document.getElementById('zhScroll');
const zhContent    = document.getElementById('zhContent');
const zoomOutBtn   = document.getElementById('zoomOut');
const zoomInBtn    = document.getElementById('zoomIn');
const zoomFitBtn   = document.getElementById('zoomFit');
const zoomLabel    = document.getElementById('zoomLabel');
const vdivider     = document.getElementById('vdivider');
const annResizer          = document.getElementById('annResizer');
const zhPanel             = document.getElementById('zhPanel');
const toggleZhBtn         = document.getElementById('toggleZhBtn');
const annStandalone       = document.getElementById('annStandalone');
const annStandaloneScroll = document.getElementById('annStandaloneScroll');
const annStandaloneContent= document.getElementById('annStandaloneContent');

/* ════════════════════════════════════════
   Persist API key
════════════════════════════════════════ */
apiKeyInput.value = localStorage.getItem('deepseek_api_key') || '';

toggleKey.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  apiKeyInput.type = isPass ? 'text' : 'password';
});

/* ════════════════════════════════════════
   File picker
════════════════════════════════════════ */
fileInput.addEventListener('change', () => {
  fileNameEl.textContent = fileInput.files[0]?.name ?? '未选择文件';
});

/* ════════════════════════════════════════
   Form submit
════════════════════════════════════════ */
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file   = fileInput.files[0];
  const apiKey = apiKeyInput.value.trim();
  if (!file)   { alert('请选择 PDF 文件'); return; }
  if (!apiKey) { alert('请输入 DeepSeek API Key'); return; }

  localStorage.setItem('deepseek_api_key', apiKey);

  resetReader();
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector('svg').style.display = 'none';
  analyzeBtn.childNodes[analyzeBtn.childNodes.length - 1].textContent = ' 处理中…';

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', apiKey);

  let sessionId, total;
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) { const err = await res.json(); throw new Error(err.detail); }
    ({ session_id: sessionId, total } = await res.json());
  } catch (err) {
    alert(`上传失败：${err.message}`);
    resetAnalyzeBtn();
    return;
  }

  emptyState.classList.add('hidden');
  readerLayout.classList.remove('hidden');
  showProgress(0, total);

  await Promise.all([
    renderPdf(sessionId),
    streamAnalysis(sessionId, total),
  ]);
});

/* ════════════════════════════════════════
   PDF Rendering
════════════════════════════════════════ */
async function renderPdf(sessionId) {
  try {
    pdfDoc = await pdfjsLib.getDocument(`/api/pdf/${sessionId}`).promise;
  } catch (err) {
    console.error('PDF load failed', err);
    return;
  }
  await renderAllPages();
}

async function renderAllPages() {
  if (!pdfDoc) return;
  pdfViewer.innerHTML = '';
  pageOffsets = [];
  const containerW = pdfScroll.clientWidth - 24;
  let cumY = 0;

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page    = await pdfDoc.getPage(i);
    const baseVP  = page.getViewport({ scale: 1 });
    const fitScale = containerW / baseVP.width;
    const scale   = fitScale * pdfZoom * DPR;
    const vp      = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.page = i;

    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    // CSS display size = physical pixels / DPR * zoom (zoom already baked in scale)
    const cssW = vp.width / DPR;
    const cssH = vp.height / DPR;
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas._cssW = cssW;
    canvas._cssH = cssH;

    wrapper.appendChild(canvas);
    pdfViewer.appendChild(wrapper);
    pageOffsets.push(cumY);
    cumY += cssH + PAGE_GAP;

    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  }
  updateZoomLabel();
  if (!zhVisible) buildStandaloneAnnotations();
}

/* ════════════════════════════════════════
   PDF Zoom
════════════════════════════════════════ */
zoomOutBtn.addEventListener('click', () => setZoom(pdfZoom - 0.25));
zoomInBtn .addEventListener('click', () => setZoom(pdfZoom + 0.25));
zoomFitBtn.addEventListener('click', () => setZoom(1.0));

function setZoom(z) {
  pdfZoom = Math.max(0.4, Math.min(3.0, z));
  renderAllPages();
}
function updateZoomLabel() {
  zoomLabel.textContent = Math.round(pdfZoom * 100) + '%';
}

/* ── Pinch-to-zoom ── */
let pinchStartDist = 0;
let pinchStartZoom = 1;

pdfScroll.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchStartDist = getPinchDist(e);
    pinchStartZoom = pdfZoom;
    e.preventDefault();
  }
}, { passive: false });

pdfScroll.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const dist = getPinchDist(e);
    const newZoom = Math.max(0.4, Math.min(3.0, pinchStartZoom * (dist / pinchStartDist)));
    pdfZoom = newZoom;
    updateZoomLabel();
    // Fast visual feedback with CSS transform; re-render on end
    pdfViewer.style.transform = `scale(${newZoom / pinchStartZoom})`;
    pdfViewer.style.transformOrigin = 'top center';
    e.preventDefault();
  }
}, { passive: false });

pdfScroll.addEventListener('touchend', (e) => {
  if (e.changedTouches.length > 0 && pinchStartDist > 0) {
    pdfViewer.style.transform = '';
    renderAllPages();
    pinchStartDist = 0;
  }
});

function getPinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}

/* ════════════════════════════════════════
   Draggable Main Divider (PDF | Chinese)
════════════════════════════════════════ */
let isDragging = false;

vdivider.addEventListener('mousedown', (e) => {
  isDragging = true;
  vdivider.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const layout = readerLayout.getBoundingClientRect();
  let pct = ((e.clientX - layout.left) / layout.width) * 100;
  pct = Math.max(20, Math.min(75, pct));
  document.documentElement.style.setProperty('--pdf-w', pct + '%');
});

document.addEventListener('mouseup', async () => {
  if (isDragging) {
    isDragging = false;
    vdivider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const savedPage = getVisiblePdfPage();
    await renderAllPages();
    // Restore position instantly (no smooth scroll — content just reflowed)
    if (pageOffsets[savedPage - 1] !== undefined) {
      pdfScroll.scrollTop = pageOffsets[savedPage - 1];
    }
  }
  if (isAnnDragging) {
    isAnnDragging = false;
    annResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

/* ════════════════════════════════════════
   Draggable Annotation Divider (Chinese | Annotation)
════════════════════════════════════════ */
let isAnnDragging = false;

annResizer.addEventListener('mousedown', (e) => {
  isAnnDragging = true;
  annResizer.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isAnnDragging) return;
  const rect = zhPanel.getBoundingClientRect();
  const annW = Math.max(120, Math.min(420, rect.right - e.clientX));
  document.documentElement.style.setProperty('--ann-w', annW + 'px');
});

/* ════════════════════════════════════════
   SSE Stream
════════════════════════════════════════ */
function streamAnalysis(sessionId, total) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/stream/${sessionId}`);
    let done = 0;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.done) {
        es.close();
        resetAnalyzeBtn();
        resolve();
        return;
      }
      appendPageResult(data);
      showProgress(++done, total);
    };
    es.onerror = () => { es.close(); resetAnalyzeBtn(); resolve(); };
  });
}

/* ════════════════════════════════════════
   Render — page result (heading + paragraphs)
════════════════════════════════════════ */
function createPageDivider(pageNum) {
  const div = document.createElement('div');
  div.className = 'page-divider';
  div.innerHTML = `<span>第 ${pageNum} 页</span>`;
  return div;
}

function createHeadingRow(text) {
  const div = document.createElement('div');
  div.className = 'heading-row';
  div.textContent = text;
  return div;
}

let paraCounter = 0;

function createParaRow(seg, page, isError) {
  const { zh = '', bold_zh = [], annotation = '' } = seg;

  const row = document.createElement('div');
  row.className = 'para-row';
  row.dataset.page = page;

  const zhCell = document.createElement('div');
  zhCell.className = 'zh-cell';

  const num = document.createElement('div');
  num.className = 'para-num';
  num.textContent = ++paraCounter;
  zhCell.appendChild(num);

  const p = document.createElement('p');
  p.className = 'zh-text';
  p.innerHTML = applyBold(zh, bold_zh);
  zhCell.appendChild(p);

  const annCell = document.createElement('div');
  annCell.className = 'ann-cell';
  const card = document.createElement('div');
  card.className = 'ann-card' + (isError ? ' error' : '');
  card.textContent = annotation;
  annCell.appendChild(card);

  row.appendChild(zhCell);
  row.appendChild(annCell);
  return row;
}

function appendPageResult(data) {
  const { page = 1, segments = [], error } = data;

  if (page !== lastRenderedPage) {
    zhContent.appendChild(createPageDivider(page));
    lastRenderedPage = page;
  }

  for (const seg of segments) {
    if (seg.type === 'heading') {
      zhContent.appendChild(createHeadingRow(seg.en || ''));
    } else {
      allSegments.push({ ...seg, page });
      zhContent.appendChild(createParaRow(seg, page, error));
    }
  }

  if (!zhVisible) buildStandaloneAnnotations();
}

/* ════════════════════════════════════════
   Apply bold to text
════════════════════════════════════════ */
function applyBold(text, phrases) {
  if (!phrases?.length) return escHtml(text);

  const positions = [];
  for (const phrase of phrases) {
    if (!phrase) continue;
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      positions.push({ start: idx, end: idx + phrase.length });
      idx = text.indexOf(phrase, idx + 1);
    }
  }
  positions.sort((a, b) => a.start - b.start);

  // Deduplicate / merge overlaps
  const merged = [];
  let lastEnd = -1;
  for (const p of positions) {
    if (p.start >= lastEnd) { merged.push(p); lastEnd = p.end; }
    else if (p.end > lastEnd) { merged[merged.length - 1].end = p.end; lastEnd = p.end; }
  }

  let html = '', cursor = 0;
  for (const { start, end } of merged) {
    html += escHtml(text.slice(cursor, start));
    html += `<strong>${escHtml(text.slice(start, end))}</strong>`;
    cursor = end;
  }
  html += escHtml(text.slice(cursor));
  return html;
}

/* ════════════════════════════════════════
   Navigation Helpers
════════════════════════════════════════ */
function getVisiblePdfPage() {
  const scrollY = pdfScroll.scrollTop + pdfScroll.clientHeight * 0.15;
  let page = 1;
  for (let i = 0; i < pageOffsets.length; i++) {
    if (pageOffsets[i] <= scrollY) page = i + 1;
    else break;
  }
  return page;
}

function scrollZhToPage(pageNum) {
  const row = zhContent.querySelector(`.para-row[data-page="${pageNum}"]`)
           || zhContent.querySelector('.para-row');
  if (row) zhScroll.scrollTo({ top: row.offsetTop, behavior: 'smooth' });
}

function scrollPdfToPage(pageNum) {
  const idx = pageNum - 1;
  if (idx >= 0 && idx < pageOffsets.length) {
    pdfScroll.scrollTo({ top: pageOffsets[idx], behavior: 'smooth' });
  }
}

function scrollAnnToPage(pageNum) {
  const card = annStandaloneContent.querySelector(`.ann-card-standalone[data-page="${pageNum}"]`);
  if (card) annStandaloneScroll.scrollTo({ top: card.offsetTop - 8, behavior: 'smooth' });
}

/* ════════════════════════════════════════
   Click-to-Jump
════════════════════════════════════════ */
pdfScroll.addEventListener('click', (e) => {
  if (window.getSelection()?.toString()) return;
  if (!pdfDoc) return;
  const wrapper = e.target.closest('.pdf-page-wrapper');
  if (!wrapper) return;
  const page = parseInt(wrapper.dataset.page) || 1;
  if (zhVisible) scrollZhToPage(page);
  else scrollAnnToPage(page);
});

zhScroll.addEventListener('click', (e) => {
  if (window.getSelection()?.toString()) return;
  const row = e.target.closest('.para-row');
  if (!row) return;
  const page = parseInt(row.dataset.page) || 1;
  scrollPdfToPage(page);
});

annStandaloneScroll.addEventListener('click', (e) => {
  if (window.getSelection()?.toString()) return;
  const card = e.target.closest('.ann-card-standalone');
  if (!card) return;
  const page = parseInt(card.dataset.page) || 1;
  scrollPdfToPage(page);
});

/* Synchronized scrolling between PDF and standalone annotation panel */
pdfScroll.addEventListener('scroll', () => {
  if (!zhVisible && !isScrollSyncing) {
    isScrollSyncing = true;
    annStandaloneScroll.scrollTop = pdfScroll.scrollTop;
    requestAnimationFrame(() => { isScrollSyncing = false; });
  }
}, { passive: true });

annStandaloneScroll.addEventListener('scroll', () => {
  if (!zhVisible && !isScrollSyncing) {
    isScrollSyncing = true;
    pdfScroll.scrollTop = annStandaloneScroll.scrollTop;
    requestAnimationFrame(() => { isScrollSyncing = false; });
  }
}, { passive: true });

/* ════════════════════════════════════════
   Toggle Chinese Panel
════════════════════════════════════════ */
function buildStandaloneAnnotations() {
  annStandaloneContent.innerHTML = '';

  const wrappers = pdfViewer.querySelectorAll('.pdf-page-wrapper');
  if (wrappers.length === 0) {
    annStandaloneContent.innerHTML =
      '<p style="color:#94a3b8;padding:20px;font-size:12px;text-align:center">PDF 加载中…</p>';
    return;
  }

  // Group segments by page number
  const byPage = {};
  for (const seg of allSegments) {
    (byPage[seg.page] = byPage[seg.page] || []).push(seg);
  }

  // Top padding matches pdfViewer's padding-top (16 px) so pages align after scroll sync
  annStandaloneContent.style.paddingTop = '16px';

  wrappers.forEach((wrapper) => {
    const canvas  = wrapper.querySelector('canvas');
    const pageNum = parseInt(wrapper.dataset.page);
    const pageH   = canvas ? canvas._cssH : 100;
    const segs    = byPage[pageNum] || [];

    // One block per PDF page, same height as the rendered page
    const block = document.createElement('div');
    block.dataset.page = pageNum;
    block.style.cssText =
      `position:relative;height:${pageH}px;flex-shrink:0;margin-bottom:${PAGE_GAP}px;`;

    if (segs.length > 0) {
      const slotH = pageH / segs.length;
      segs.forEach((seg, j) => {
        const card = document.createElement('div');
        card.className = 'ann-card-standalone';
        card.dataset.page = pageNum;
        card.textContent = seg.annotation;
        // Vertically center each card within its equal-height slot
        const topPx = j * slotH + Math.max((slotH - 60) / 2, 6);
        const maxH  = Math.max(slotH - 12, 24);
        card.style.cssText =
          `position:absolute;top:${topPx}px;left:10px;right:10px;max-height:${maxH}px;`;
        block.appendChild(card);
      });
    }

    annStandaloneContent.appendChild(block);
  });

  // Restore scroll alignment with PDF
  annStandaloneScroll.scrollTop = pdfScroll.scrollTop;
}

function toggleZh() {
  zhVisible = !zhVisible;
  zhPanel.classList.toggle('hidden', !zhVisible);
  annStandalone.classList.toggle('hidden', zhVisible);
  toggleZhBtn.textContent = zhVisible ? '隐藏译文' : '显示译文';
  toggleZhBtn.classList.toggle('zh-hidden', !zhVisible);
  if (!zhVisible) buildStandaloneAnnotations();
}

toggleZhBtn.addEventListener('click', toggleZh);

/* ════════════════════════════════════════
   Keyboard shortcuts for zoom
════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;
  if (e.target.tagName === 'INPUT') return;
  if ((e.metaKey || e.ctrlKey) && e.key === '=') { e.preventDefault(); setZoom(pdfZoom + 0.25); }
  if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); setZoom(pdfZoom - 0.25); }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); setZoom(1.0); }
});

/* ════════════════════════════════════════
   Utilities
════════════════════════════════════════ */
function showProgress(done, total) {
  progressBox.classList.remove('hidden');
  progressFill.style.width = total ? (done / total * 100) + '%' : '0%';
  progressText.textContent = `${done} / ${total}`;
}

function resetReader() {
  zhContent.innerHTML = '';
  pdfViewer.innerHTML = '';
  annStandaloneContent.innerHTML = '';
  pdfDoc = null;
  pdfZoom = 1.0;
  pageOffsets = [];
  lastRenderedPage = -1;
  paraCounter = 0;
  allSegments = [];
  if (!zhVisible) {
    zhVisible = true;
    zhPanel.classList.remove('hidden');
    annStandalone.classList.add('hidden');
    toggleZhBtn.textContent = '隐藏译文';
    toggleZhBtn.classList.remove('zh-hidden');
  }
}

function resetAnalyzeBtn() {
  analyzeBtn.disabled = false;
  analyzeBtn.querySelector('svg').style.display = '';
  analyzeBtn.childNodes[analyzeBtn.childNodes.length - 1].textContent = ' 开始分析';
}

function escHtml(s = '') {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
