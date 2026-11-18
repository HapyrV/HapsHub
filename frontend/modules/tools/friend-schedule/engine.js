// The Friend Schedule engine from VRCX-Friend-Schedule, unchanged apart from the wrapper below and findEarliestTimestamp.
// Loaded as a script for the page and as a worker for long histories.
(function () {
'use strict';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BASE_BUCKET_MINUTES = 15;
const DEFAULT_RECORDING_GAP_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WINDOW_PADDING_MS = 30 * MINUTE_MS;
const DEFAULT_MAX_SESSION_MS = 24 * 60 * 60 * 1000;
const MIN_SAMPLE_COVERAGE = 0.5;

const formatterCache = new Map();

// Increment this whenever the serialized worker result changes. Database cache
// rows from an older engine version are ignored and rebuilt automatically.
const FRIEND_SCHEDULE_CACHE_VERSION = 3;

function normalizeFriendScheduleOptions(options = {}) {
    const requestedRangeDays = Number(options.rangeDays);
    const resolutionMinutes = [15, 30, 60].includes(
        Number(options.resolutionMinutes)
    )
        ? Number(options.resolutionMinutes)
        : 15;
    // Zero intentionally means "all history"; using `|| 30` here would turn
    // that valid selection back into the 30-day default.
    const rangeDays =
        Number.isFinite(requestedRangeDays) && requestedRangeDays >= 0
            ? requestedRangeDays
            : 30;
    const probabilityThreshold = Math.max(
        1,
        Math.round(Number(options.probabilityThreshold) || 20)
    );
    const timezone = validateTimeZone(options.timezone);

    return {
        ...options,
        rangeDays,
        resolutionMinutes,
        probabilityThreshold,
        timezone,
        scope: ['current', 'favorites', 'former', 'selected'].includes(
            options.scope
        )
            ? options.scope
            : 'current',
        selectedFriendIds: uniqueStrings(options.selectedFriendIds),
        favoriteFriendIds: uniqueStrings(options.favoriteFriendIds),
        // `null` means the caller did not provide a live friend list. An empty
        // array is meaningful and must not fall back to stale database rows.
        currentFriendIds: Array.isArray(options.currentFriendIds)
            ? uniqueStrings(options.currentFriendIds)
            : null,
        includeSelf: Boolean(options.includeSelf),
        selfCutoffMs: finiteOrNull(options.selfCutoffMs),
        recordingGapMs:
            finiteOrNull(options.recordingGapMs) ?? DEFAULT_RECORDING_GAP_MS,
        windowPaddingMs:
            finiteOrNull(options.windowPaddingMs) ?? DEFAULT_WINDOW_PADDING_MS,
        maxSessionMs:
            finiteOrNull(options.maxSessionMs) ?? DEFAULT_MAX_SESSION_MS,
        excludeHours: normalizeHourWindow(options.excludeHours, false),
        meeting: normalizeMeetingOptions(options.meeting)
    };
}

function validateTimeZone(timezone) {
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (!timezone || timezone === 'system') {
        return fallback;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
        return timezone;
    } catch {
        return fallback;
    }
}

/**
 * Convert a calendar date at midnight in an IANA time zone to UTC milliseconds.
 * The short fixed-point loop handles daylight-saving offsets without relying
 * on the host computer's local time zone.
 */
function zonedDateStartMs(dateString, timezone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || '');
    if (!match) {
        return null;
    }
    const target = Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
    );
    const targetDate = new Date(target);
    if (
        targetDate.getUTCFullYear() !== Number(match[1]) ||
        targetDate.getUTCMonth() !== Number(match[2]) - 1 ||
        targetDate.getUTCDate() !== Number(match[3])
    ) {
        return null;
    }
    let candidate = target;
    const resolvedTimezone = validateTimeZone(timezone);
    for (let attempt = 0; attempt < 4; attempt++) {
        const parts = getZonedParts(candidate, resolvedTimezone);
        const displayedAsUtc = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute
        );
        const correction = target - displayedAsUtc;
        candidate += correction;
        if (correction === 0) {
            break;
        }
    }
    return candidate;
}

function buildFriendSchedule(payload = {}) {
    const options = normalizeFriendScheduleOptions(payload.options);
    const rangeEndMs = finiteOrNull(payload.nowMs) ?? Date.now();
    const explicitRangeStart = finiteOrNull(options.rangeStartMs);
    const recordingBeganMs = parseTimestamp(options.recordingBeganAt);
    const rangeStartMs =
        explicitRangeStart ??
        (options.rangeDays > 0
            ? rangeEndMs - options.rangeDays * DAY_MS
            : (recordingBeganMs ??
              findEarliestTimestamp(payload) ??
              rangeEndMs));

    // Normalize all source rows once in the worker. Every later pass uses
    // numeric timestamps and stable VRChat user IDs.
    const currentFriends = Array.isArray(payload.currentFriends)
        ? payload.currentFriends
        : [];
    const friendHistory = normalizeRelationshipEvents(payload.friendHistory);
    const presenceEvents = normalizePresenceEvents(payload.presenceEvents);
    const currentIds = new Set(
        options.currentFriendIds ??
            currentFriends.map((friend) => friend.userId).filter(Boolean)
    );
    const friendMeta = buildFriendMetadata(
        currentFriends,
        friendHistory,
        presenceEvents
    );
    const friendIds = resolveFriendIds({
        options,
        currentIds,
        friendHistory
    });

    const inRangePresence = presenceEvents.filter(
        (event) =>
            event.timestamp >= rangeStartMs && event.timestamp <= rangeEndMs
    );
    // Presence traffic from every friend acts as an approximate VRCX
    // heartbeat. Long quiet gaps are excluded instead of being counted as
    // periods with zero online friends.
    const recordingWindows = buildObservationWindows(
        inRangePresence.map((event) => event.timestamp),
        rangeStartMs,
        rangeEndMs,
        options.recordingGapMs,
        options.windowPaddingMs
    );
    let observationWindows = recordingWindows;

    if (options.includeSelf) {
        // gamelog_location is installation-wide, so the selected account
        // cutoff is applied before intersecting with the recording windows.
        const selfSessions = buildSelfSessions(
            payload.selfActivityRows,
            rangeStartMs,
            rangeEndMs,
            options.selfCutoffMs
        );
        observationWindows = intersectIntervals(
            observationWindows,
            selfSessions
        );
    }

    const coverage = buildCoverageSamples(
        observationWindows,
        options.timezone,
        options.resolutionMinutes
    );
    const membershipByUser = buildMembershipIntervals({
        friendIds,
        currentIds,
        friendHistory,
        presenceEvents,
        rangeStartMs,
        rangeEndMs
    });
    const sessionsByUser = buildPresenceSessions({
        friendIds,
        presenceEvents,
        membershipByUser,
        observationWindows,
        rangeStartMs,
        rangeEndMs,
        maxSessionMs: options.maxSessionMs
    });

    const aggregation = aggregateSchedule({
        friendIds,
        friendMeta,
        sessionsByUser,
        membershipByUser,
        presenceEvents,
        coverage,
        rangeStartMs,
        rangeEndMs,
        timezone: options.timezone,
        resolutionMinutes: options.resolutionMinutes,
        probabilityThreshold: options.probabilityThreshold,
        excludeHours: options.excludeHours
    });
    const recordedMs = recordingWindows.reduce(
        (sum, interval) => sum + Math.max(0, interval.end - interval.start),
        0
    );
    const analyzedMs = observationWindows.reduce(
        (sum, interval) => sum + Math.max(0, interval.end - interval.start),
        0
    );
    const coveredWeekKeys = new Set();
    for (const sample of coverage.sampleMeta.values()) {
        if (
            (coverage.coverageByKey.get(sample.key) || 0) >= MIN_SAMPLE_COVERAGE
        ) {
            coveredWeekKeys.add(sample.weekKey);
        }
    }

    return {
        cacheVersion: FRIEND_SCHEDULE_CACHE_VERSION,
        generatedAt: new Date(rangeEndMs).toISOString(),
        rangeStartAt: new Date(rangeStartMs).toISOString(),
        rangeEndAt: new Date(rangeEndMs).toISOString(),
        timezone: options.timezone,
        resolutionMinutes: options.resolutionMinutes,
        slotsPerDay: (24 * 60) / options.resolutionMinutes,
        probabilityThreshold: options.probabilityThreshold,
        scope: options.scope,
        cells: aggregation.cells,
        contributorsByCell: aggregation.contributorsByCell,
        summary: {
            selectedFriends: friendIds.size,
            representedFriends: aggregation.representedFriendIds.size,
            missingFriends: aggregation.missingFriends,
            coveragePercent:
                rangeEndMs > rangeStartMs
                    ? Math.min(
                          100,
                          (recordedMs / (rangeEndMs - rangeStartMs)) * 100
                      )
                    : 0,
            analyzedCoveragePercent:
                rangeEndMs > rangeStartMs
                    ? Math.min(
                          100,
                          (analyzedMs / (rangeEndMs - rangeStartMs)) * 100
                      )
                    : 0,
            coveredWeeks: coveredWeekKeys.size,
            recordingGaps: Math.max(0, recordingWindows.length - 1),
            recordingBeganAt:
                recordingBeganMs !== null
                    ? new Date(recordingBeganMs).toISOString()
                    : inRangePresence[0]?.createdAt || '',
            observationWindows: recordingWindows.length,
            analyzedWindows: observationWindows.length,
            peakCell: findExtremeCell(aggregation.cells, 'maximum', 'max'),
            quietestCell: findExtremeCell(aggregation.cells, 'average', 'min')
        }
    };
}

function rankBestRecurringBlocks(
    cells,
    resolutionMinutes,
    meetingOptions = {}
) {
    const meeting = normalizeMeetingOptions(meetingOptions);
    const slotsPerDay = (24 * 60) / resolutionMinutes;
    const durationSlots = Math.max(
        1,
        Math.round((meeting.durationHours * 60) / resolutionMinutes)
    );
    const allowedDays = new Set(meeting.allowedDays);
    const candidates = [];

    // Enumerate each possible recurring start and reject incomplete or
    // excluded blocks before scoring them.
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        if (!allowedDays.has(dayIndex)) {
            continue;
        }
        for (let slotIndex = 0; slotIndex < slotsPerDay; slotIndex++) {
            const startMinutes = slotIndex * resolutionMinutes;
            if (
                !isMinuteInWindow(
                    startMinutes,
                    meeting.startHour * 60,
                    meeting.endHour * 60
                )
            ) {
                continue;
            }

            const blockCells = [];
            const recurringIndexes = [];
            let valid = true;
            for (let offset = 0; offset < durationSlots; offset++) {
                const absoluteSlot =
                    dayIndex * slotsPerDay + slotIndex + offset;
                const wrapped = absoluteSlot % (7 * slotsPerDay);
                const cell = cells[wrapped];
                const minuteOfDay =
                    (slotIndex * resolutionMinutes +
                        offset * resolutionMinutes) %
                    (24 * 60);
                if (
                    !cell ||
                    cell.excluded ||
                    cell.sampleCount === 0 ||
                    !isMinuteInWindow(
                        minuteOfDay,
                        meeting.startHour * 60,
                        meeting.endHour * 60
                    )
                ) {
                    valid = false;
                    break;
                }
                blockCells.push(cell);
                recurringIndexes.push(wrapped);
            }
            if (!valid) {
                continue;
            }

            const average = mean(blockCells.map((cell) => cell.average));
            const medianValue = mean(blockCells.map((cell) => cell.median));
            const probability = Math.min(
                ...blockCells.map((cell) => cell.probability)
            );
            const coveredWeeks = Math.min(
                ...blockCells.map((cell) => cell.coveredWeeks)
            );
            const score =
                average *
                (0.55 + (probability / 100) * 0.45) *
                Math.min(1, coveredWeeks / 8);
            const endAbsolute =
                dayIndex * slotsPerDay + slotIndex + durationSlots;

            candidates.push({
                dayIndex,
                startMinutes,
                endDayIndex: Math.floor(endAbsolute / slotsPerDay) % 7,
                endMinutes: (endAbsolute % slotsPerDay) * resolutionMinutes,
                durationHours: meeting.durationHours,
                average,
                median: medianValue,
                probability,
                coveredWeeks,
                score,
                recurringIndexes
            });
        }
    }

    candidates.sort(
        (left, right) =>
            right.score - left.score ||
            right.average - left.average ||
            left.dayIndex - right.dayIndex ||
            left.startMinutes - right.startMinutes
    );

    // Keep the results useful by suppressing blocks that overlap at least half
    // of an already-selected recommendation.
    const selected = [];
    for (const candidate of candidates) {
        const candidateSet = new Set(candidate.recurringIndexes);
        const overlapsExisting = selected.some((entry) => {
            let overlap = 0;
            for (const index of entry.recurringIndexes) {
                if (candidateSet.has(index)) {
                    overlap++;
                }
            }
            return overlap / durationSlots >= 0.5;
        });
        if (!overlapsExisting) {
            selected.push(candidate);
        }
        if (selected.length >= 5) {
            break;
        }
    }

    return selected.map(
        ({ recurringIndexes: _recurringIndexes, ...entry }) => entry
    );
}

function normalizePresenceEvents(input) {
    return (Array.isArray(input) ? input : [])
        .map((event) => ({
            id: Number(event.id) || 0,
            createdAt: event.createdAt || event.created_at || '',
            timestamp: parseTimestamp(event.createdAt || event.created_at),
            userId: event.userId || event.user_id || '',
            displayName: event.displayName || event.display_name || '',
            type: event.type
        }))
        .filter(
            (event) =>
                event.timestamp !== null &&
                event.userId &&
                (event.type === 'Online' || event.type === 'Offline')
        )
        .sort(
            (left, right) =>
                left.timestamp - right.timestamp || left.id - right.id
        );
}

function normalizeRelationshipEvents(input) {
    return (Array.isArray(input) ? input : [])
        .map((event) => ({
            id: Number(event.id || event.rowId) || 0,
            createdAt: event.createdAt || event.created_at || '',
            timestamp: parseTimestamp(event.createdAt || event.created_at),
            userId: event.userId || event.user_id || '',
            displayName: event.displayName || event.display_name || '',
            type: event.type
        }))
        .filter(
            (event) =>
                event.timestamp !== null &&
                event.userId &&
                (event.type === 'Friend' || event.type === 'Unfriend')
        )
        .sort(
            (left, right) =>
                left.timestamp - right.timestamp || left.id - right.id
        );
}

function resolveFriendIds({ options, currentIds, friendHistory }) {
    if (options.scope === 'favorites') {
        const favoriteIds = new Set(options.favoriteFriendIds);
        return new Set(
            [...currentIds].filter((userId) => favoriteIds.has(userId))
        );
    }
    if (options.scope === 'selected') {
        return new Set(options.selectedFriendIds);
    }
    if (options.scope === 'former') {
        const lastRelationship = new Map();
        for (const event of friendHistory) {
            lastRelationship.set(event.userId, event.type);
        }
        return new Set(
            [...lastRelationship]
                .filter(
                    ([userId, type]) =>
                        type === 'Unfriend' && !currentIds.has(userId)
                )
                .map(([userId]) => userId)
        );
    }
    return new Set(currentIds);
}

function buildFriendMetadata(currentFriends, friendHistory, presenceEvents) {
    const result = new Map();
    for (const event of friendHistory) {
        if (event.userId && event.displayName) {
            result.set(event.userId, {
                userId: event.userId,
                displayName: event.displayName
            });
        }
    }
    for (const event of presenceEvents) {
        if (event.userId && event.displayName) {
            result.set(event.userId, {
                userId: event.userId,
                displayName: event.displayName
            });
        }
    }
    for (const friend of currentFriends) {
        if (friend.userId) {
            result.set(friend.userId, {
                userId: friend.userId,
                displayName:
                    friend.displayName ||
                    result.get(friend.userId)?.displayName ||
                    friend.userId
            });
        }
    }
    return result;
}

function buildMembershipIntervals({
    friendIds,
    currentIds,
    friendHistory,
    presenceEvents,
    rangeStartMs,
    rangeEndMs
}) {
    const historyByUser = groupByUser(friendHistory);
    const presenceByUser = groupByUser(presenceEvents);
    const result = new Map();

    for (const userId of friendIds) {
        const history = historyByUser.get(userId) || [];
        const presence = presenceByUser.get(userId) || [];
        const beforeRange = history.filter(
            (event) => event.timestamp < rangeStartMs
        );
        const inRange = history.filter(
            (event) =>
                event.timestamp >= rangeStartMs && event.timestamp <= rangeEndMs
        );
        const lastBefore = beforeRange.at(-1);
        let active = lastBefore
            ? lastBefore.type === 'Friend'
            : currentIds.has(userId) || inRange[0]?.type === 'Unfriend';
        let start = active
            ? Math.max(rangeStartMs, presence[0]?.timestamp ?? rangeStartMs)
            : null;
        const intervals = [];

        for (const event of inRange) {
            if (event.type === 'Friend') {
                if (!active) {
                    start = Math.max(rangeStartMs, event.timestamp);
                    active = true;
                }
            } else if (event.type === 'Unfriend' && active) {
                if (start !== null && event.timestamp > start) {
                    intervals.push({ start, end: event.timestamp });
                }
                start = null;
                active = false;
            }
        }

        if (!active && currentIds.has(userId)) {
            const lastRelationshipAt =
                history.at(-1)?.timestamp ?? rangeStartMs;
            const firstPresenceAfter = presence.find(
                (event) => event.timestamp >= lastRelationshipAt
            );
            if (firstPresenceAfter) {
                active = true;
                start = Math.max(rangeStartMs, firstPresenceAfter.timestamp);
            }
        }
        if (active && start !== null && start < rangeEndMs) {
            intervals.push({ start, end: rangeEndMs });
        }
        result.set(userId, mergeIntervals(intervals));
    }

    return result;
}

function buildPresenceSessions({
    friendIds,
    presenceEvents,
    membershipByUser,
    observationWindows,
    rangeStartMs,
    rangeEndMs,
    maxSessionMs
}) {
    const byUser = groupByUser(
        presenceEvents.filter((event) => friendIds.has(event.userId))
    );
    const result = new Map();

    for (const userId of friendIds) {
        const events = byUser.get(userId) || [];
        let openStart = null;
        const sessions = [];
        for (const event of events) {
            if (event.timestamp > rangeEndMs) {
                break;
            }
            if (event.type === 'Online') {
                if (openStart !== null && event.timestamp > openStart) {
                    sessions.push({
                        start: openStart,
                        end: Math.min(event.timestamp, openStart + maxSessionMs)
                    });
                }
                openStart = event.timestamp;
            } else if (openStart !== null) {
                if (event.timestamp > openStart) {
                    sessions.push({
                        start: openStart,
                        end: Math.min(event.timestamp, openStart + maxSessionMs)
                    });
                }
                openStart = null;
            }
        }
        if (openStart !== null && openStart < rangeEndMs) {
            sessions.push({
                start: openStart,
                end: Math.min(rangeEndMs, openStart + maxSessionMs)
            });
        }

        // A reconstructed online session only counts where friendship
        // membership and observable VRCX time overlap.
        const clipped = intersectIntervals(
            intersectIntervals(sessions, membershipByUser.get(userId) || []),
            observationWindows
        )
            .map((session) => ({
                start: Math.max(rangeStartMs, session.start),
                end: Math.min(rangeEndMs, session.end)
            }))
            .filter((session) => session.end > session.start);
        result.set(userId, mergeIntervals(clipped));
    }

    return result;
}

function buildSelfSessions(inputRows, rangeStartMs, rangeEndMs, cutoffMs) {
    const rows = (Array.isArray(inputRows) ? inputRows : [])
        .map((row) => ({
            timestamp: parseTimestamp(row.createdAt || row.created_at),
            time: Math.max(0, Number(row.time) || 0)
        }))
        .filter(
            (row) =>
                row.timestamp !== null &&
                (cutoffMs === null || row.timestamp >= cutoffMs)
        )
        .sort((left, right) => left.timestamp - right.timestamp);
    const sessions = [];

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        let duration = row.time;
        if (duration === 0) {
            // The active gamelog row is initially stored with a zero duration.
            // Infer its tail from the next location or the analysis end.
            duration =
                index < rows.length - 1
                    ? rows[index + 1].timestamp - row.timestamp
                    : rangeEndMs - row.timestamp;
            duration = Math.min(duration, DAY_MS);
        }
        if (duration > 0) {
            sessions.push({
                start: Math.max(rangeStartMs, row.timestamp),
                end: Math.min(rangeEndMs, row.timestamp + duration)
            });
        }
    }
    return mergeIntervals(
        sessions.filter((session) => session.end > session.start),
        5 * MINUTE_MS
    );
}

function buildObservationWindows(
    timestamps,
    rangeStartMs,
    rangeEndMs,
    maxGapMs,
    paddingMs
) {
    const sorted = [...new Set(timestamps)]
        .filter(
            (timestamp) =>
                Number.isFinite(timestamp) &&
                timestamp >= rangeStartMs &&
                timestamp <= rangeEndMs
        )
        .sort((left, right) => left - right);
    if (sorted.length === 0) {
        return [];
    }

    const windows = [];
    let start = Math.max(rangeStartMs, sorted[0] - paddingMs);
    let previous = sorted[0];
    for (let index = 1; index < sorted.length; index++) {
        const timestamp = sorted[index];
        if (timestamp - previous > maxGapMs) {
            windows.push({
                start,
                end: Math.min(rangeEndMs, previous + paddingMs)
            });
            start = Math.max(rangeStartMs, timestamp - paddingMs);
        }
        previous = timestamp;
    }
    windows.push({
        start,
        end:
            rangeEndMs - previous <= maxGapMs
                ? rangeEndMs
                : Math.min(rangeEndMs, previous + paddingMs)
    });
    return mergeIntervals(
        windows.filter((window) => window.end > window.start)
    );
}

function buildCoverageSamples(windows, timezone, resolutionMinutes) {
    const coverageByKey = new Map();
    const sampleMeta = new Map();
    for (const window of windows) {
        walkInterval(
            window.start,
            window.end,
            timezone,
            resolutionMinutes,
            ({ key, fraction, meta }) => {
                coverageByKey.set(
                    key,
                    (coverageByKey.get(key) || 0) + fraction
                );
                const previous = sampleMeta.get(key);
                sampleMeta.set(key, {
                    ...meta,
                    key,
                    startMs: Math.min(
                        previous?.startMs ?? meta.startMs,
                        meta.startMs
                    ),
                    endMs: Math.max(previous?.endMs ?? meta.endMs, meta.endMs)
                });
            }
        );
    }
    return { coverageByKey, sampleMeta };
}

function aggregateSchedule({
    friendIds,
    friendMeta,
    sessionsByUser,
    membershipByUser,
    presenceEvents,
    coverage,
    rangeStartMs,
    rangeEndMs,
    timezone,
    resolutionMinutes,
    probabilityThreshold,
    excludeHours
}) {
    const slotsPerDay = (24 * 60) / resolutionMinutes;
    const cellCount = 7 * slotsPerDay;
    const concurrencyByKey = new Map();
    const lastObservedByUser = new Map();
    const representedFriendIds = new Set();
    const rawSamplesByCell = Array.from({ length: cellCount }, () => []);
    const weekKeysByCell = Array.from({ length: cellCount }, () => new Set());
    const coverageSamplesByCell = Array.from({ length: cellCount }, () => []);
    const contributorStatsByCell = Array.from({ length: cellCount }, () => []);
    const usableCoverageSamples = [];
    const midpoint = rangeStartMs + (rangeEndMs - rangeStartMs) / 2;

    for (const event of presenceEvents) {
        if (
            friendIds.has(event.userId) &&
            event.timestamp >= rangeStartMs &&
            event.timestamp <= rangeEndMs
        ) {
            lastObservedByUser.set(event.userId, event.createdAt);
        }
    }

    // Coverage is independent of friend sessions. Index it once so the
    // aggregate and contributor passes share the exact same denominators.
    for (const [key, coverageValue] of coverage.coverageByKey) {
        if (coverageValue < MIN_SAMPLE_COVERAGE) {
            continue;
        }
        const meta = coverage.sampleMeta.get(key);
        if (!meta) {
            continue;
        }
        const cellIndex = meta.dayIndex * slotsPerDay + meta.slotIndex;
        usableCoverageSamples.push({ key, coverageValue, cellIndex });
        weekKeysByCell[cellIndex].add(meta.weekKey);
        coverageSamplesByCell[cellIndex].push({
            timestamp: meta.startMs + (meta.endMs - meta.startMs) / 2
        });
    }
    for (const samples of coverageSamplesByCell) {
        samples.sort((left, right) => left.timestamp - right.timestamp);
    }

    // Process one friend at a time. The large per-date sample map is reduced
    // to 672 recurring cells and discarded immediately, keeping memory bounded
    // for installations with years of presence history.
    for (const userId of friendIds) {
        const sampleMap = new Map();
        const sessions = sessionsByUser.get(userId) || [];
        for (const session of sessions) {
            walkInterval(
                session.start,
                session.end,
                timezone,
                resolutionMinutes,
                ({ key, fraction }) => {
                    concurrencyByKey.set(
                        key,
                        (concurrencyByKey.get(key) || 0) + fraction
                    );
                    sampleMap.set(key, (sampleMap.get(key) || 0) + fraction);
                }
            );
        }
        if (sampleMap.size > 0) {
            representedFriendIds.add(userId);
        }
        const statsByCell = new Map();
        for (const [key, contribution] of sampleMap) {
            const coverageValue = coverage.coverageByKey.get(key) || 0;
            if (coverageValue < MIN_SAMPLE_COVERAGE) {
                continue;
            }
            const sample = coverage.sampleMeta.get(key);
            if (!sample) {
                continue;
            }
            const cellIndex = sample.dayIndex * slotsPerDay + sample.slotIndex;
            let stats = statsByCell.get(cellIndex);
            if (!stats) {
                stats = {
                    total: 0,
                    onlineSamples: 0,
                    recentOnline: 0,
                    olderOnline: 0,
                    weekKeys: new Set()
                };
                statsByCell.set(cellIndex, stats);
            }
            const normalizedContribution = contribution / coverageValue;
            stats.total += normalizedContribution;
            if (normalizedContribution >= 0.5) {
                stats.onlineSamples++;
                stats.weekKeys.add(sample.weekKey);
                const sampleTimestamp =
                    sample.startMs + (sample.endMs - sample.startMs) / 2;
                if (sampleTimestamp >= midpoint) {
                    stats.recentOnline++;
                } else {
                    stats.olderOnline++;
                }
            }
        }

        for (const [cellIndex, stats] of statsByCell) {
            const membership = membershipByUser.get(userId) || [];
            const coverageSamples = coverageSamplesByCell[cellIndex];
            contributorStatsByCell[cellIndex].push({
                userId,
                displayName: friendMeta.get(userId)?.displayName || userId,
                lastObservedAt: lastObservedByUser.get(userId) || '',
                eligibleSamples: countEligibleSamples(
                    coverageSamples,
                    membership,
                    rangeStartMs,
                    rangeEndMs
                ),
                eligibleRecentSamples: countEligibleSamples(
                    coverageSamples,
                    membership,
                    midpoint,
                    rangeEndMs
                ),
                eligibleOlderSamples: countEligibleSamples(
                    coverageSamples,
                    membership,
                    rangeStartMs,
                    midpoint
                ),
                stats
            });
        }
    }

    for (const { key, coverageValue, cellIndex } of usableCoverageSamples) {
        const concurrency = (concurrencyByKey.get(key) || 0) / coverageValue;
        rawSamplesByCell[cellIndex].push(concurrency);
    }

    // Fold actual dates into the recurring day-of-week × time-of-day grid.
    const cells = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        for (let slotIndex = 0; slotIndex < slotsPerDay; slotIndex++) {
            const cellIndex = dayIndex * slotsPerDay + slotIndex;
            const samples = rawSamplesByCell[cellIndex];
            const startMinutes = slotIndex * resolutionMinutes;
            const excluded =
                excludeHours.enabled &&
                isMinuteInWindow(
                    startMinutes,
                    excludeHours.startHour * 60,
                    excludeHours.endHour * 60
                );
            cells.push({
                dayIndex,
                slotIndex,
                startMinutes,
                average: samples.length ? mean(samples) : 0,
                median: samples.length ? median(samples) : 0,
                maximum: samples.length ? Math.max(...samples) : 0,
                probability: samples.length
                    ? (samples.filter((value) => value >= probabilityThreshold)
                          .length /
                          samples.length) *
                      100
                    : 0,
                sampleCount: samples.length,
                coveredWeeks: weekKeysByCell[cellIndex].size,
                excluded
            });
        }
    }

    const contributorsByCell = contributorStatsByCell.map((entries) =>
        entries
            .filter((entry) => entry.eligibleSamples > 0)
            .map(
                ({
                    stats,
                    eligibleSamples,
                    eligibleRecentSamples,
                    eligibleOlderSamples,
                    ...entry
                }) => {
                    const recentRate = eligibleRecentSamples
                        ? stats.recentOnline / eligibleRecentSamples
                        : 0;
                    const olderRate = eligibleOlderSamples
                        ? stats.olderOnline / eligibleOlderSamples
                        : 0;
                    const trendDelta = recentRate - olderRate;
                    return {
                        ...entry,
                        probability:
                            (stats.onlineSamples / eligibleSamples) * 100,
                        averagePresence: stats.total / eligibleSamples,
                        observedPeriods: stats.onlineSamples,
                        // Keep the denominator so the UI can distinguish a
                        // strong history (for example, 18/20) from a single
                        // observation (1/1), even though both can round to a
                        // high percentage.
                        eligiblePeriods: eligibleSamples,
                        coveredWeeks: stats.weekKeys.size,
                        trend:
                            eligibleRecentSamples < 2 ||
                            eligibleOlderSamples < 2
                                ? 'limited'
                                : Math.abs(trendDelta) < 0.15
                                  ? 'stable'
                                  : trendDelta > 0
                                    ? 'increasing'
                                    : 'decreasing'
                    };
                }
            )
            .sort(
                (left, right) =>
                    right.probability - left.probability ||
                    right.averagePresence - left.averagePresence ||
                    left.displayName.localeCompare(right.displayName)
            )
            .slice(0, 30)
    );
    const missingFriends = [...friendIds]
        .filter((userId) => !representedFriendIds.has(userId))
        .map((userId) => ({
            userId,
            displayName: friendMeta.get(userId)?.displayName || userId
        }))
        .sort((left, right) =>
            left.displayName.localeCompare(right.displayName)
        );

    return {
        cells,
        contributorsByCell,
        representedFriendIds,
        missingFriends
    };
}

function walkInterval(startMs, endMs, timezone, resolutionMinutes, callback) {
    if (endMs <= startMs) {
        return;
    }
    const baseMs = BASE_BUCKET_MINUTES * MINUTE_MS;
    const resolutionMs = resolutionMinutes * MINUTE_MS;
    let cursor = startMs;
    // Walk fixed UTC quarter-hours, then convert each midpoint to local time.
    // This preserves daylight-saving transitions without manual offset math.
    while (cursor < endMs) {
        const nextBoundary = (Math.floor(cursor / baseMs) + 1) * baseMs;
        const segmentEnd = Math.min(endMs, nextBoundary);
        const midpoint = cursor + (segmentEnd - cursor) / 2;
        const parts = getZonedParts(midpoint, timezone);
        const minutes = parts.hour * 60 + parts.minute;
        const slotIndex = Math.floor(minutes / resolutionMinutes);
        const key = `${parts.dateKey}|${slotIndex}`;
        callback({
            key,
            fraction: (segmentEnd - cursor) / resolutionMs,
            meta: {
                dateKey: parts.dateKey,
                dayIndex: parts.dayIndex,
                slotIndex,
                weekKey: isoWeekKey(parts.year, parts.month, parts.day),
                startMs: cursor,
                endMs: segmentEnd
            }
        });
        cursor = segmentEnd;
    }
}

function getZonedParts(timestamp, timezone) {
    let formatter = formatterCache.get(timezone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        });
        formatterCache.set(timezone, formatter);
    }
    const values = {};
    for (const part of formatter.formatToParts(new Date(timestamp))) {
        if (part.type !== 'literal') {
            values[part.type] = part.value;
        }
    }
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    return {
        year,
        month,
        day,
        hour,
        minute,
        dateKey: `${values.year}-${values.month}-${values.day}`,
        dayIndex: new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    };
}

function isoWeekKey(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const weekDay = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekDay);
    const weekYear = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(weekYear, 0, 1));
    const weekNumber = Math.ceil(
        ((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7
    );
    return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function findExtremeCell(cells, property, direction) {
    const usable = cells.filter(
        (cell) => !cell.excluded && cell.sampleCount > 0
    );
    if (usable.length === 0) {
        return null;
    }
    return usable.reduce((best, cell) => {
        if (!best) {
            return cell;
        }
        return direction === 'min'
            ? cell[property] < best[property]
                ? cell
                : best
            : cell[property] > best[property]
              ? cell
              : best;
    }, null);
}

function findEarliestTimestamp(payload) {
    const candidates = [
        ...(Array.isArray(payload.presenceEvents)
            ? payload.presenceEvents
            : []),
        ...(Array.isArray(payload.friendHistory) ? payload.friendHistory : [])
    ]
        .map((entry) => parseTimestamp(entry.createdAt || entry.created_at))
        .filter((timestamp) => timestamp !== null);
    // Not Math.min(...candidates): a long history is too many arguments for a worker's stack.
    let earliest = null;
    for (const timestamp of candidates) {
        if (earliest === null || timestamp < earliest) earliest = timestamp;
    }
    return earliest;
}

function normalizeHourWindow(value, defaultEnabled) {
    return {
        enabled:
            typeof value?.enabled === 'boolean'
                ? value.enabled
                : defaultEnabled,
        startHour: clampHour(value?.startHour, 0),
        endHour: clampHour(value?.endHour, 8)
    };
}

function normalizeMeetingOptions(value = {}) {
    const duration = Number(value.durationHours);
    return {
        durationHours: [1, 2, 3, 4].includes(duration) ? duration : 3,
        allowedDays:
            Array.isArray(value.allowedDays) && value.allowedDays.length
                ? [
                      ...new Set(
                          value.allowedDays
                              .map(Number)
                              .filter(
                                  (dayIndex) => dayIndex >= 0 && dayIndex <= 6
                              )
                      )
                  ]
                : [0, 1, 2, 3, 4, 5, 6],
        startHour: clampHour(value.startHour, 0),
        endHour: clampHour(value.endHour, 0)
    };
}

function clampHour(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(23, Math.max(0, Math.round(number)));
}

function isMinuteInWindow(minute, startMinute, endMinute) {
    if (startMinute === endMinute) {
        return true;
    }
    if (startMinute < endMinute) {
        return minute >= startMinute && minute < endMinute;
    }
    return minute >= startMinute || minute < endMinute;
}

function groupByUser(entries) {
    const result = new Map();
    for (const entry of entries) {
        let values = result.get(entry.userId);
        if (!values) {
            values = [];
            result.set(entry.userId, values);
        }
        values.push(entry);
    }
    return result;
}

/**
 * Count covered date/slot samples whose midpoint falls within membership.
 * Both inputs are sorted, so binary searches avoid walking every recorded day
 * for every friend and recurring heatmap cell.
 */
function countEligibleSamples(samples, intervals, rangeStartMs, rangeEndMs) {
    let count = 0;
    for (const interval of intervals) {
        const start = Math.max(interval.start, rangeStartMs);
        const end = Math.min(interval.end, rangeEndMs);
        if (end <= start) {
            continue;
        }
        const first = firstSampleAtOrAfter(samples, start);
        const afterLast = firstSampleAtOrAfter(samples, end);
        count += Math.max(0, afterLast - first);
    }
    // A sample spanning a very short unfriend/refriend gap can overlap two
    // membership intervals; it is still one eligible observation.
    return Math.min(samples.length, count);
}

function firstSampleAtOrAfter(samples, value) {
    let low = 0;
    let high = samples.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (samples[middle].timestamp < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function intersectIntervals(left, right) {
    if (!left.length || !right.length) {
        return [];
    }
    const sortedLeft = [...left].sort((a, b) => a.start - b.start);
    const sortedRight = [...right].sort((a, b) => a.start - b.start);
    const result = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < sortedLeft.length && rightIndex < sortedRight.length) {
        const a = sortedLeft[leftIndex];
        const b = sortedRight[rightIndex];
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.end, b.end);
        if (end > start) {
            result.push({ start, end });
        }
        if (a.end <= b.end) {
            leftIndex++;
        } else {
            rightIndex++;
        }
    }
    return result;
}

function mergeIntervals(intervals, gapMs = 0) {
    if (!intervals.length) {
        return [];
    }
    const sorted = intervals
        .filter(
            (interval) =>
                Number.isFinite(interval.start) &&
                Number.isFinite(interval.end) &&
                interval.end > interval.start
        )
        .sort((left, right) => left.start - right.start);
    if (!sorted.length) {
        return [];
    }
    const result = [{ ...sorted[0] }];
    for (let index = 1; index < sorted.length; index++) {
        const current = sorted[index];
        const previous = result[result.length - 1];
        if (current.start <= previous.end + gapMs) {
            previous.end = Math.max(previous.end, current.end);
        } else {
            result.push({ ...current });
        }
    }
    return result;
}

function median(values) {
    if (!values.length) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

function parseTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (!value) {
        return null;
    }
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function uniqueStrings(input) {
    return Array.isArray(input)
        ? [
              ...new Set(
                  input.filter((value) => typeof value === 'string' && value)
              )
          ]
        : [];
}

// The page sends the history as it keeps it, [time, on, userId] rows plus a name table, and the events are built
// here: building and copying one object per event on the page took ~45 ms on a long history (issue 12).
function expandFriendSchedulePayload(compact) {
    const { rows = {}, names = {}, ...rest } = compact || {};
    const toEvents = (list, on, off) => (list || []).map((row, index) => ({
        id: index + 1,
        createdAt: row[0],
        type: row[1] ? on : off,
        userId: row[2],
        displayName: names[row[2]] || '',
    }));
    return {
        ...rest,
        presenceEvents: toEvents(rows.presence, 'Online', 'Offline'),
        friendHistory: toEvents(rows.relationships, 'Friend', 'Unfriend'),
        selfActivityRows: (rows.self || []).map(row => ({ createdAt: row[0], time: row[1] })),
    };
}

const api = { FRIEND_SCHEDULE_CACHE_VERSION, normalizeFriendScheduleOptions, validateTimeZone, zonedDateStartMs, buildFriendSchedule, expandFriendSchedulePayload, rankBestRecurringBlocks };
self.FriendScheduleEngine = api;

if (typeof document === 'undefined') {
    self.onmessage = event => {
        const { seq, payload } = event.data;
        try {
            self.postMessage({ seq, result: buildFriendSchedule(expandFriendSchedulePayload(payload)) });
        } catch (error) {
            self.postMessage({ seq, error: String(error?.message || error) });
        }
    };
}
})();
