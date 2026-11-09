// Upstream update check: what changed since the last commit reviewed in each source.

function hubUpstreamCheck() {
    const list = document.getElementById('hubUpstreamList');
    if (list) list.innerHTML = `<div class="sf-desc">${esc(t('hub.update.checking', 'Checking GitHub...'))}</div>`;
    sendToCS({ action: 'hubUpstreamCheck' });
}

function _hubUpstreamStatus(report) {
    if (report.error) return report.error;
    if (report.newCommits === null || report.newCommits === undefined)
        return t('hub.update.no_baseline', 'No commit reviewed yet. Mark the current one as reviewed to start tracking.');
    if (report.newCommits === 0) return t('hub.update.up_to_date', 'Nothing new since your last review.');
    const since = (report.reviewedCommit || '').slice(0, 7);
    return t('hub.update.new_commits', '{count} new commit(s) since {commit}')
        .replace('{count}', report.newCommits).replace('{commit}', since);
}

function _hubUpstreamRow(report) {
    const flags = (report.flags || []).map(flag =>
        `<span class="vrcn-badge" title="${esc(flag.files.join('\n'))}">${esc(flag.category)}: ${flag.files.length}</span>`).join(' ');
    const truncated = report.filesTruncated
        ? `<div class="sf-desc">${esc(t('hub.update.truncated', 'Over 300 files changed, so these flags may be incomplete.'))}</div>` : '';
    const links = [
        report.compareUrl ? [report.compareUrl, t('hub.update.see_changes', 'See changes')] : null,
        report.releaseUrl ? [report.releaseUrl, report.latestRelease || t('hub.update.release', 'Release')] : null,
    ].filter(Boolean).map(([url, label]) =>
        `<button class="vrcn-button-round" data-url="${esc(url)}" onclick="hubUpstreamOpen(this)">${esc(label)}</button>`).join(' ');
    const canReview = !report.error && report.headCommit && report.newCommits !== 0;
    const review = canReview
        ? `<button class="vrcn-button-round" data-id="${esc(report.id)}" data-commit="${esc(report.headCommit)}" onclick="hubUpstreamMarkReviewed(this)">${esc(t('hub.update.mark_reviewed', 'Mark as reviewed'))}</button>`
        : '';
    return `<div class="hub-upstream-row" data-source="${esc(report.id)}" style="margin-top:12px;">
        <div><strong>${esc(report.name)}</strong> <span class="sf-desc hub-upstream-status"${report.error ? ' style="color:var(--err);"' : ''}>${esc(_hubUpstreamStatus(report))}</span></div>
        ${flags ? `<div style="margin-top:6px;">${flags}</div>` : ''}${truncated}
        <div class="hub-upstream-actions" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${links} ${review}</div>
    </div>`;
}

function onHubUpstream(payload) {
    const list = document.getElementById('hubUpstreamList');
    if (list) list.innerHTML = (payload.reports || []).map(_hubUpstreamRow).join('');
}

function hubUpstreamOpen(button) {
    sendToCS({ action: 'openUrl', url: button.dataset.url });
}

function hubUpstreamMarkReviewed(button) {
    button.disabled = true;
    sendToCS({ action: 'hubUpstreamReviewed', id: button.dataset.id, commit: button.dataset.commit });
}

function onHubUpstreamReviewed(payload) {
    const row = document.querySelector(`.hub-upstream-row[data-source="${CSS.escape(payload.id || '')}"]`);
    if (!row) return;
    const status = row.querySelector('.hub-upstream-status');
    if (payload.saved) {
        if (status) status.textContent = t('hub.update.up_to_date', 'Nothing new since your last review.');
        row.querySelector('[data-commit]')?.remove();
    } else {
        if (status) status.textContent = t('hub.update.review_failed', 'Could not save that. The hub database may be unavailable.');
        const button = row.querySelector('[data-commit]');
        if (button) button.disabled = false;
    }
}
