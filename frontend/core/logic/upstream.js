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

// Space Calibrator's Steam branch: what's installed, new beta builds, and switching.

let _hubSteamReport = null;
let _hubSteamPending = null;
let _hubSteamMessage = null;

function hubSteamRefresh() {
    sendToCS({ action: 'hubSteamStatus' });
}

function _hubSteamBuildLine(label, build) {
    if (!build) return '';
    const when = build.updated ? ` (${new Date(build.updated).toLocaleDateString()})` : '';
    return `<div class="sf-desc">${esc(label)}: ${esc(build.buildId)}${esc(when)}</div>`;
}

function _hubSteamBetaStatus(report) {
    const beta = report.betaBuild;
    if (!beta) return '';
    if (report.reviewedBeta === beta.buildId)
        return `<div class="sf-desc">${esc(t('hub.steam.reviewed', 'You have reviewed this beta build.'))}</div>`;
    const label = report.reviewedBeta
        ? t('hub.steam.new_build', 'New beta build since your last review.')
        : t('hub.steam.no_review', 'No beta build reviewed yet.');
    return `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span class="sf-desc">${esc(label)}</span>
        <button class="vrcn-button-round" data-build="${esc(beta.buildId)}" onclick="hubSteamMarkReviewed(this)">${esc(t('hub.update.mark_reviewed', 'Mark as reviewed'))}</button>
    </div>`;
}

function _hubSteamRender() {
    const panel = document.getElementById('hubSteamBranch');
    const report = _hubSteamReport;
    if (!panel || !report) return;
    const installed = report.installed;
    const title = `<div><strong>${esc(t('hub.steam.title', 'Space Calibrator on Steam'))}</strong></div>`;
    if (!installed) {
        panel.innerHTML = `<div class="hub-steam-branch">${title}<div class="sf-desc">${esc(t('hub.steam.not_installed', 'Not installed through Steam.'))}</div></div>`;
        return;
    }

    const moving = installed.branch !== installed.mountedBranch;
    const status = (moving
        ? t('hub.steam.installing', 'Installed: {mounted}, build {build}. Steam is moving it to {branch}.')
        : t('hub.steam.installed', 'Installed: {branch}, build {build}.'))
        .replace('{mounted}', installed.mountedBranch).replace('{branch}', installed.branch).replace('{build}', installed.buildId);

    const running = _hubSteamPending === 'running';
    const options = [['public', t('hub.steam.public', 'Public')], ['beta', t('hub.steam.beta', 'Beta')]].map(([branch, label]) =>
        `<button class="vrcn-button-round${installed.branch === branch ? ' vrcn-btn-join' : ''}" data-branch="${branch}" ${installed.branch === branch || running ? 'disabled' : ''} onclick="hubSteamAskSwitch(this)">${esc(label)}</button>`).join(' ');

    let confirm = '';
    if (running) {
        confirm = `<div class="sf-desc" style="margin-top:6px;">${esc(t('hub.steam.running', 'Switching. Steam will close and reopen, which can take a minute.'))}</div>`;
    } else if (_hubSteamPending) {
        confirm = `<div style="margin-top:6px;">
            <div class="sf-desc">${esc(t('hub.steam.confirm', 'This closes Steam, changes the branch, and reopens Steam so it can download the build. VRChat, SteamVR and Steam games have to be closed first.'))}</div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                <button class="vrcn-button-round vrcn-btn-join" onclick="hubSteamConfirmSwitch()">${esc(t('hub.steam.confirm_button', 'Close Steam and switch'))}</button>
                <button class="vrcn-button-round" onclick="hubSteamCancelSwitch()">${esc(t('hub.steam.cancel', 'Cancel'))}</button>
            </div>
        </div>`;
    }

    const message = _hubSteamMessage
        ? `<div class="sf-desc" style="margin-top:6px;${_hubSteamMessage.problem ? 'color:var(--err);' : ''}">${esc(_hubSteamMessage.text)}</div>` : '';
    const watchOff = report.watchOn ? '' : `<div class="sf-desc">${esc(t('hub.steam.watch_off', 'The beta is not part of update checks. Turn that on in Hub modules.'))}</div>`;
    const error = report.error ? `<div class="sf-desc" style="color:var(--err);">${esc(report.error)}</div>` : '';

    panel.innerHTML = `<div class="hub-steam-branch">${title}
        <div class="sf-desc">${esc(status)}</div>
        ${_hubSteamBuildLine(t('hub.steam.public', 'Public'), report.publicBuild)}
        ${_hubSteamBuildLine(t('hub.steam.beta', 'Beta'), report.betaBuild)}
        ${_hubSteamBetaStatus(report)}${watchOff}${error}
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${options}
            <button class="vrcn-button-round" onclick="sendToCS({action:'hubSteamOpen'})">${esc(t('hub.steam.open', 'Open in Steam'))}</button>
        </div>${confirm}${message}
    </div>`;
}

function onHubSteamBranch(report) {
    // A status read knows nothing about Steam's builds, so keep the ones already fetched.
    if (!report.checkedOnline && _hubSteamReport) {
        report.publicBuild = _hubSteamReport.publicBuild;
        report.betaBuild = _hubSteamReport.betaBuild;
    }
    _hubSteamReport = report;
    _hubSteamRender();
}

function hubSteamAskSwitch(button) {
    _hubSteamPending = button.dataset.branch;
    _hubSteamMessage = null;
    _hubSteamRender();
}

function hubSteamCancelSwitch() {
    _hubSteamPending = null;
    _hubSteamRender();
}

function hubSteamConfirmSwitch() {
    const branch = _hubSteamPending;
    if (!branch || branch === 'running') return;
    _hubSteamPending = 'running';
    _hubSteamRender();
    sendToCS({ action: 'hubSteamSwitch', branch });
}

function onHubSteamSwitched(result) {
    _hubSteamPending = null;
    _hubSteamMessage = { text: result.message, problem: ['Failed', 'Blocked', 'Reverted'].includes(result.outcome) };
    _hubSteamRender();
}

function hubSteamMarkReviewed(button) {
    button.disabled = true;
    sendToCS({ action: 'hubSteamReviewed', build: button.dataset.build });
}

// Fill the panel the first time Settings shows it, and refresh it each time after.
(function _hubSteamWatchPanel() {
    const panel = document.getElementById('hubSteamBranch');
    if (!panel) { setTimeout(_hubSteamWatchPanel, 1000); return; }
    new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) hubSteamRefresh();
    }).observe(panel);
})();
