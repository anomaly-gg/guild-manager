// Timers → "Import from screenshot": read a schedule screenshot (Discord schedule post) in the
// browser with Tesseract OCR, match each line to a timer, let the officer review, then apply.
// Parsing/matching lives in schedule-parse.js; the server applies the list in one batch
// (worker routes/schedule-import.js). ES module; uses shell globals by name
// (api, showToast, guard, currentTeamId, teamBosses, teamSpawnGroups, teamTz, teamTimeStr).

import { esc } from './timer-cards.js?v=20260929e';
import { parseScheduleText, buildPlan, laterGroupsFor } from './schedule-parse.js?v=20260929c';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let workerPromise = null;   // one OCR worker per page load; the language data downloads once
let plan = [], presets = null, onDone = null;

const host = () => document.getElementById('deathModal');
const $ = (sel) => host()?.querySelector(sel);

function loadScript(src) {
    return new Promise((ok, bad) => {
        if (window.Tesseract) return ok();
        const s = document.createElement('script');
        s.src = src; s.onload = () => ok(); s.onerror = () => bad(new Error('Could not load the text reader'));
        document.head.appendChild(s);
    });
}

async function ocrWorker(progress) {
    if (!workerPromise) {
        workerPromise = (async () => {
            await loadScript(TESSERACT);
            const w = await window.Tesseract.createWorker('eng', 1, { logger: (m) => progress?.(m) });
            await w.setParameters({ tessedit_pageseg_mode: '6' });   // one block of lines
            return w;
        })().catch(e => { workerPromise = null; throw e; });
    }
    return workerPromise;
}

// ---------------------------------------------------------------- modal

export function open(opts = {}) {
    onDone = opts.onDone || null;
    plan = [];
    host().innerHTML = `
        <div class="modal-backdrop" data-close="1">
            <div class="card modal-card modal-wide si-card">
                <h2>Import timers from a screenshot</h2>
                <p class="tf-help">A screenshot of a schedule post, like <code>2:04 AM | Lady Dalia (85) | @Kongreso</code> lines under a date. Existing timers get their next spawn updated; bosses you don't have yet are added. Nothing changes until you confirm.</p>
                <div class="si-drop" data-role="drop" tabindex="0">
                    <div class="si-drop-main">Paste it here (Ctrl+V), drop the image, or <label class="si-pick">choose a file<input type="file" accept="image/*" data-role="file" hidden></label></div>
                    <div class="si-drop-sub">The image is read on this device; it is not uploaded.</div>
                </div>
                <div data-role="status" class="si-status"></div>
                <div data-role="review"></div>
                <div class="tf-actions">
                    <button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
                    <button type="button" class="btn btn-primary" data-act="apply" disabled>Apply</button>
                </div>
            </div>
        </div>`;
    const back = host().firstElementChild;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.addEventListener('click', onClick);
    back.addEventListener('change', onChange);
    back.addEventListener('input', onChange);
    const drop = $('[data-role="drop"]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files?.[0]; if (f) read(f); });
    document.addEventListener('paste', onPaste);
    drop.focus();
    ocrWorker().catch(() => {});   // start downloading the reader while they pick the image
}

function close() {
    document.removeEventListener('paste', onPaste);
    host().innerHTML = '';
}

function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    read(item.getAsFile());
}

function status(html) { const el = $('[data-role="status"]'); if (el) el.innerHTML = html; }

const read = guard('import.read', async (file) => {
    if (!file || !file.type.startsWith('image/')) { showToast('That is not an image'); return; }
    const url = URL.createObjectURL(file);
    $('[data-role="drop"]').innerHTML = `<img class="si-preview" src="${url}" alt="">`;
    status('<div class="spinner"></div> Reading the screenshot…');
    const w = await ocrWorker((m) => {
        if (m.status === 'recognizing text') status(`<div class="spinner"></div> Reading the screenshot… ${Math.round(m.progress * 100)}%`);
        else if (/load/.test(m.status)) status('<div class="spinner"></div> Getting the text reader ready (first time only)…');
    });
    const { data } = await w.recognize(file);
    if (!presets) presets = ((await api('GET', '/api/presets')).presets || []).flatMap(p => p.bosses || []);
    const rows = parseScheduleText(data.text);
    plan = buildPlan(rows, { bosses: teamBosses, presets, groups: teamSpawnGroups || [], tz: teamTz() });
    status('');
    renderReview(data.text);
});

// ---------------------------------------------------------------- review

const ACTION = { update: ['Update', 'chip-accent'], add: ['Add', 'chip-success'], later: ['Later', 'chip-muted'], skip: ['Skip', 'chip-muted'] };

function targetOptions(p) {
    const addLabel = `New: ${p.preset ? p.preset.name : p.row.name}`;
    const opts = [`<option value="new" ${!p.boss ? 'selected' : ''}>${esc(addLabel)}</option>`];
    for (const b of [...teamBosses].sort((a, b) => a.name.localeCompare(b.name))) {
        opts.push(`<option value="${esc(b.id)}" ${p.boss?.id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`);
    }
    return opts.join('');
}

function rowHtml(p, i) {
    const [label, cls] = ACTION[p.checked ? p.action : 'skip'];
    const day = new Date(p.at).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: teamTz() });
    const group = p.group ? `<span class="chip chip-accent">@${esc(p.group.name)}</span>`
        : p.groupUnknown ? `<span class="si-warn" title="No spawn group with this name (Settings → Daily schedule post)">@${esc(p.row.tag)}?</span>` : '';
    const rule = p.needsRule && !p.boss ? `<label class="si-rule">respawn <input type="number" min="1" max="999" data-rule="${i}" value="${p.ruleHours || ''}" placeholder="h"> h</label>` : '';
    const note = p.reason ? `<span class="si-note">${esc(p.reason)}</span>` : p.fuzzy ? '<span class="si-note si-warn">check the match</span>' : '';
    return `<div class="si-row ${p.checked ? '' : 'off'}">
        <input type="checkbox" data-check="${i}" ${p.checked ? 'checked' : ''}>
        <span class="si-time">${esc(teamTimeStr(p.at))}<small>${esc(day)}</small></span>
        <span class="si-read" title="${esc(p.row.line)}"><span class="si-name">${esc(p.row.name)}${p.row.level ? ` <small>(${p.row.level})</small>` : ''}</span>${group}</span>
        <select class="si-target" data-target="${i}">${targetOptions(p)}</select>
        <span class="si-extra">${rule}${note}</span>
        <span class="chip ${cls} si-act">${label}</span>
    </div>`;
}

function renderReview(rawText) {
    const el = $('[data-role="review"]');
    if (!el) return;
    if (!plan.length) {
        el.innerHTML = `<div class="si-empty">No schedule lines found. The screenshot needs lines with a time and a boss name, like <code>2:04 AM | Lady Dalia</code>.</div>
            <details class="si-raw"><summary>What was read</summary><pre>${esc(rawText)}</pre></details>`;
        updateApply();
        return;
    }
    el.innerHTML = `<div class="si-list">${plan.map(rowHtml).join('')}</div>
        <p class="tf-help">Times are team time (${esc(teamTz())}). A boss listed more than once: its first upcoming line sets the timer, the later lines set the groups of its following spawns. Untick anything that looks wrong.</p>
        <details class="si-raw"><summary>What was read</summary><pre>${esc(rawText)}</pre></details>`;
    updateApply();
}

function refreshRow(i) {
    const row = host().querySelectorAll('.si-row')[i];
    if (!row) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = rowHtml(plan[i], i);
    row.replaceWith(tmp.firstElementChild);
    updateApply();
}

function applicable(p) { return p.checked && (p.action === 'update' || p.action === 'add') && (p.boss || p.preset || p.ruleHours > 0); }

function updateApply() {
    const n = plan.filter(applicable).length;
    const btn = $('[data-act="apply"]');
    if (btn) { btn.disabled = n === 0; btn.textContent = n ? `Apply ${n} change${n !== 1 ? 's' : ''}` : 'Apply'; }
}

function onChange(e) {
    const t = e.target;
    if (t.dataset.role === 'file' && t.files?.[0]) { read(t.files[0]); return; }
    if (t.dataset.check !== undefined) {
        const p = plan[+t.dataset.check];
        p.checked = t.checked;
        if (p.checked && p.action === 'skip') p.action = p.boss ? 'update' : 'add';   // the officer overrides a skip
        refreshRow(+t.dataset.check);
    } else if (t.dataset.target !== undefined && e.type === 'change') {
        const p = plan[+t.dataset.target];
        p.boss = t.value === 'new' ? null : teamBosses.find(b => b.id === t.value) || null;
        p.fuzzy = false;
        if (p.action !== 'skip') p.action = p.boss ? 'update' : 'add';
        p.needsRule = !p.boss && !p.preset;
        refreshRow(+t.dataset.target);
    } else if (t.dataset.rule !== undefined) {
        const p = plan[+t.dataset.rule];
        p.ruleHours = parseFloat(t.value) || 0;
        if (p.ruleHours > 0 && !p.checked) { p.checked = true; refreshRow(+t.dataset.rule); host().querySelector(`[data-rule="${t.dataset.rule}"]`)?.focus(); }
        updateApply();
    }
}

function onClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    else if (act === 'apply') apply();
}

const apply = guard('import.apply', async () => {
    const items = plan.filter(applicable).map(p => {
        const later = laterGroupsFor(plan, p);
        const it = { nextSpawn: p.at, groupId: p.group?.id || null, ...(later.some(Boolean) ? { laterGroups: later } : {}) };
        if (p.boss) it.bossId = p.boss.id;
        else if (p.preset) it.add = { ...p.preset, name: p.preset.name };
        else it.add = { name: p.row.name, type: 'interval', intervalMs: Math.round(p.ruleHours * 3600000) };
        return it;
    });
    if (!items.length) return;
    const btn = $('[data-act="apply"]'); if (btn) btn.disabled = true;
    const res = await api('POST', `/api/teams/${currentTeamId}/bosses/import-schedule`, { items });
    if (res.error) { showToast(res.error); updateApply(); return; }
    const parts = [];
    if (res.updated?.length) parts.push(`${res.updated.length} updated`);
    if (res.added?.length) parts.push(`${res.added.length} added`);
    if (res.skipped?.length) parts.push(`${res.skipped.length} skipped (${[...new Set(res.skipped.map(s => s.why))].join(', ')})`);
    showToast(parts.join(' · ') || 'Nothing changed');
    close();
    onDone?.();
});
